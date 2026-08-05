import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { filterSchema } from "./filters.ts";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// An origin is scheme://host[:port] and nothing else. Returns the canonical
// form a browser would send in the Origin header - lowercased host, default
// port dropped, no trailing slash - so a value that means the right origin
// still matches one. A path, query or fragment is rejected rather than
// silently discarded, since it would match more than was written, and `*`
// fails here too: with api_key optional, a gateway may be answering anyone
// who can reach it.
function toOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
  return url.origin;
}

const commonProviderFields = {
  base_url: z.url().optional(),
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
  headers: z.record(z.string(), z.string()).default({}),
};

const providerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("openai"),
    ...commonProviderFields,
    api_key: z.string().min(1),
    base_url: z.url().default("https://api.openai.com/v1"),
  }),
  z.strictObject({
    type: z.literal("openai-compatible"),
    ...commonProviderFields,
    api_key: z.string().min(1).optional(),
    base_url: z.url(),
  }),
  z.strictObject({
    type: z.literal("anthropic"),
    ...commonProviderFields,
    api_key: z.string().min(1),
    base_url: z.url().default("https://api.anthropic.com/v1"),
    anthropic_version: z.string().default("2023-06-01"),
    default_max_tokens: z.number().int().positive().default(4096),
  }),
  z.strictObject({
    type: z.literal("gemini"),
    ...commonProviderFields,
    api_key: z.string().min(1),
    base_url: z.url().default("https://generativelanguage.googleapis.com/v1beta"),
  }),
]);

const rawConfigSchema = z.strictObject({
  server: z
    .strictObject({
      // Loopback unless the operator says otherwise. Reachable from the network
      // is a decision worth making deliberately, not one to inherit - the
      // observability endpoints are open by default and disclose which
      // providers you use, how much you spend, and which are failing.
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(8080),
      api_key: z.string().min(1).optional(),
      // Named callers, so one can be revoked by deleting a line rather than by
      // rotating a secret everybody shares. Not accounts: there is no state
      // here, no budget, and no per-caller routing - just who may call.
      api_keys: z.record(z.string().regex(identifier), z.string().min(1)).optional(),
      max_body_bytes: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024),
      idle_timeout_seconds: z.number().int().min(0).max(255).default(0),
      // Bounds the gap between request-body chunks, so a slow upload is fine
      // but one that stops arriving cannot hold a handler open indefinitely.
      body_timeout_ms: z.number().int().min(1_000).max(600_000).default(30_000),
      // Browser origins allowed to read the observability endpoints. Absent
      // means no response ever carries CORS headers.
      // Puts /metrics and /readyz behind api_key. /healthz stays open whatever
      // this says, so container and orchestrator probes keep working.
      protect_observability: z.boolean().default(false),
      allow_origin: z
        .array(
          z
            .string()
            .refine(
              (value) => toOrigin(value) !== undefined,
              "must be an origin such as https://ui.example - no path, no query, never '*'",
            )
            // Stored canonically, so what is compared against the Origin header
            // is the form a browser sends rather than the form someone typed.
            .transform((value) => toOrigin(value) ?? value),
        )
        .min(1)
        .optional(),
    })
    // Two ways to say who may call is one too many: which wins would be a
    // guess, and guessing wrong about an auth setting is the expensive kind.
    .refine(
      (server) => server.api_key === undefined || server.api_keys === undefined,
      "set either server.api_key or server.api_keys, not both",
    )
    // An empty set reads as "these callers may in" while naming nobody.
    .refine(
      (server) => server.api_keys === undefined || Object.keys(server.api_keys).length > 0,
      "server.api_keys must name at least one caller",
    )
    // authorized() waves everything through when no key is set, so the flag
    // on its own would read as protection while providing none.
    .refine(
      (server) =>
        !server.protect_observability || server.api_key !== undefined || server.api_keys !== undefined,
      "protect_observability needs server.api_key or server.api_keys to be set",
    )
    // Bun closes an idle connection on its own. If it gets there first the body
    // timeout can never fire, leaving a setting that reads as protection while
    // providing none - and the client a bare close instead of its 408.
    .refine(
      (server) =>
        server.idle_timeout_seconds === 0 || server.idle_timeout_seconds * 1_000 > server.body_timeout_ms,
      "idle_timeout_seconds must be longer than body_timeout_ms, or 0 to disable it",
    )
    .prefault({}),
  routing: z
    .strictObject({
      retries: z.number().int().min(0).max(3).default(0),
      // 529 is Anthropic's overloaded_error; without it an overloaded target
      // would neither retry nor fall back.
      retry_statuses: z.array(z.number().int().min(400).max(599)).default([429, 500, 502, 503, 504, 529]),
      backoff_initial_ms: z.number().int().min(0).max(10_000).default(200),
      backoff_max_ms: z.number().int().min(0).max(30_000).default(2_000),
      // Opt in: `failures: 0` keeps routing purely a function of the current
      // request, with no dependence on what earlier requests did.
      circuit_breaker: z
        .strictObject({
          failures: z.number().int().min(0).max(100).default(0),
          cooldown_ms: z.number().int().min(0).max(3_600_000).default(30_000),
        })
        // A zero cooldown would make an enabled breaker skip nothing, which
        // reads as protection while providing none.
        .refine(
          (breaker) => breaker.failures === 0 || breaker.cooldown_ms > 0,
          "cooldown_ms must be positive when failures is set",
        )
        .prefault({}),
    })
    .prefault({}),
  providers: z
    .record(z.string().regex(identifier), providerSchema)
    .refine((providers) => Object.keys(providers).length > 0, "At least one provider is required."),
  routes: z
    .record(
      z
        .string()
        .regex(identifier)
        .refine((name) => !name.includes("/"), "Route aliases cannot contain '/'."),
      z.array(z.string().min(3).max(512)).min(1),
    )
    .default({}),
  filters: z.array(filterSchema).default([]),
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type TinyRouterConfig = z.infer<typeof rawConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

function expandString(value: string, environment: Record<string, string | undefined>): string {
  return value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g,
    (_, name: string, fallback: string | undefined) => {
      const resolved = environment[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`Environment variable ${name} is required by the configuration.`);
    },
  );
}

function expandEnvironment(value: unknown, environment: Record<string, string | undefined>): unknown {
  if (typeof value === "string") return expandString(value, environment);
  if (Array.isArray(value)) return value.map((item) => expandEnvironment(item, environment));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, expandEnvironment(child, environment)]),
    );
  }
  return value;
}

// The container image sets TINYROUTER_HOST because a process bound to loopback
// inside a container never receives a published port. Reading it only where the
// file says nothing keeps an explicit host authoritative, and means the image
// works for any config rather than only one that spells out the placeholder.
function hostFromEnvironment(value: unknown, environment: Record<string, string | undefined>): unknown {
  const fromEnvironment = environment.TINYROUTER_HOST;
  if (fromEnvironment === undefined || fromEnvironment === "") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const server = root.server ?? {};
  if (server === null || typeof server !== "object" || Array.isArray(server)) return value;
  const fields = server as Record<string, unknown>;
  if (fields.host !== undefined) return value;
  return { ...root, server: { ...fields, host: fromEnvironment } };
}

function validateReferences(config: TinyRouterConfig): TinyRouterConfig {
  for (const [route, targets] of Object.entries(config.routes)) {
    for (const target of targets) {
      const slash = target.indexOf("/");
      if (slash < 1 || slash === target.length - 1) {
        throw new ConfigError(`Route '${route}' has invalid target '${target}'; expected provider/model.`);
      }
      const providerId = target.slice(0, slash);
      if (!Object.hasOwn(config.providers, providerId)) {
        throw new ConfigError(`Route '${route}' references unknown provider '${providerId}'.`);
      }
    }
  }
  for (const [index, filter] of config.filters.entries()) {
    for (const providerId of filter.providers ?? []) {
      if (!Object.hasOwn(config.providers, providerId)) {
        throw new ConfigError(`Filter ${index + 1} references unknown provider '${providerId}'.`);
      }
    }
  }
  return config;
}

export function parseConfig(
  source: string,
  environment: Record<string, string | undefined> = process.env,
): TinyRouterConfig {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new ConfigError("The configuration is not valid YAML.", { cause: error });
  }

  let expanded: unknown;
  try {
    expanded = expandEnvironment(raw, environment);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("Could not expand configuration environment variables.", { cause: error });
  }

  const result = rawConfigSchema.safeParse(hostFromEnvironment(expanded, environment));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${detail}`);
  }
  return validateReferences(result.data);
}

export async function loadConfig(path: string): Promise<TinyRouterConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Could not read configuration file '${path}'.`, { cause: error });
  }
  return parseConfig(source);
}

export function redactConfig(config: TinyRouterConfig): unknown {
  return {
    ...config,
    server: {
      ...config.server,
      ...(config.server.api_key === undefined ? {} : { api_key: "[redacted]" }),
      ...(config.server.api_keys === undefined
        ? {}
        : {
            // Names are useful in a dump; the secrets behind them are not.
            api_keys: Object.fromEntries(
              Object.keys(config.server.api_keys).map((name) => [name, "[redacted]"]),
            ),
          }),
    },
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, provider]) => [
        id,
        {
          ...provider,
          ...(provider.api_key === undefined ? {} : { api_key: "[redacted]" }),
          // Header values routinely carry credentials (Authorization, x-api-key, ...).
          headers: Object.fromEntries(Object.keys(provider.headers).map((name) => [name, "[redacted]"])),
        },
      ]),
    ),
  };
}
