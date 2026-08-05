import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig, redactConfig } from "../src/config.ts";

describe("configuration", () => {
  test("expands environment variables and applies defaults", () => {
    const config = parseConfig(
      `
providers:
  upstream:
    type: openai-compatible
    base_url: https://example.test/v1
    api_key: \${UPSTREAM_KEY}
routes:
  fast: [upstream/model-a]
`,
      { UPSTREAM_KEY: "secret" },
    );

    expect(config.server.port).toBe(8080);
    expect(config.routing.retry_statuses).toContain(503);
    expect(config.routing.retry_statuses).toContain(529);
    expect(config.routing.backoff_initial_ms).toBe(200);
    expect(config.routing.backoff_max_ms).toBe(2000);
    expect(config.providers.upstream?.api_key).toBe("secret");
    expect(config.routes.fast).toEqual(["upstream/model-a"]);
  });

  test("fails when an environment variable is absent", () => {
    expect(() =>
      parseConfig(
        `
providers:
  openai:
    type: openai
    api_key: \${MISSING_KEY}
`,
        {},
      ),
    ).toThrow(ConfigError);
  });

  test("rejects routes that reference unknown providers", () => {
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
routes:
  fast: [missing/model]
`),
    ).toThrow("unknown provider 'missing'");
  });

  test("redacts inbound and provider secrets", () => {
    const config = parseConfig(`
server:
  api_key: inbound
providers:
  openai:
    type: openai
    api_key: provider-secret
`);
    expect(JSON.stringify(redactConfig(config))).not.toContain("provider-secret");
    expect(JSON.stringify(redactConfig(config))).not.toContain("inbound");
  });

  test("accepts filters and defaults to none", () => {
    const config = parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    patterns: [email]
`);
    expect(config.filters).toEqual([{ type: "redact", patterns: ["email"] }]);
    expect(
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
`).filters,
    ).toEqual([]);
  });

  test("rejects a circuit breaker that could never open", () => {
    // failures > 0 with a zero cooldown reads as enabled but never skips a
    // target, which is worse than being off because it looks protective.
    expect(() =>
      parseConfig(`
routing:
  circuit_breaker:
    failures: 3
    cooldown_ms: 0
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
`),
    ).toThrow(ConfigError);
    // Disabled with a zero cooldown is meaningless but harmless.
    expect(
      parseConfig(`
routing:
  circuit_breaker:
    failures: 0
    cooldown_ms: 0
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
`).routing.circuit_breaker.failures,
    ).toBe(0);
  });

  test("rejects unknown built-in filter patterns", () => {
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: block
    patterns: [social_security]
`),
    ).toThrow(ConfigError);
  });

  test("rejects invalid custom filter regexes", () => {
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    name: broken
    pattern: "[unclosed"
`),
    ).toThrow(/valid regular expression/);
  });

  test("rejects filters scoped to unknown providers, and empty scopes", () => {
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    patterns: [email]
    providers: [missing]
`),
    ).toThrow(/unknown provider 'missing'/);
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    patterns: [email]
    providers: []
`),
    ).toThrow(ConfigError);
  });

  test("rejects unknown keys instead of silently dropping them", () => {
    // A `provider:` typo used to strip the scope and widen the filter to every
    // provider; a misplaced `filters:` block used to disable filtering.
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    patterns: [email]
    provider: [local]
`),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig(`
routing:
  filters:
    - type: block
      patterns: [email]
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
`),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
    base_ur1: typo
`),
    ).toThrow(ConfigError);
  });

  test("rejects filters scoped to inherited object properties", () => {
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    patterns: [email]
    providers: [constructor]
`),
    ).toThrow(/unknown provider 'constructor'/);
  });

  test("rejects custom filter patterns without a name", () => {
    expect(() =>
      parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
filters:
  - type: redact
    pattern: "EMP-[0-9]+"
`),
    ).toThrow(/name/);
  });

  test("redacts provider header values", () => {
    const config = parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1
    headers:
      Authorization: Bearer header-secret
      x-tenant: plain-value
`);
    const redacted = JSON.stringify(redactConfig(config));
    expect(redacted).not.toContain("header-secret");
    expect(redacted).not.toContain("plain-value");
    expect(redacted).toContain("Authorization");
  });

  test("accepts exact origins for allow_origin and rejects loose ones", () => {
    const withOrigins = parseConfig(`
server:
  allow_origin: ["https://ui.example", "http://localhost:5173"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`);
    expect(withOrigins.server.allow_origin).toEqual(["https://ui.example", "http://localhost:5173"]);

    const reject = (value: string) =>
      expect(() =>
        parseConfig(`
server:
  allow_origin: ["${value}"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`),
      ).toThrow(ConfigError);

    // A wildcard would let any page on the internet reach a gateway that, with
    // api_key unset, is not asking anyone for credentials.
    reject("*");
    // An origin has no path; accepting one would silently match more than the
    // operator wrote.
    reject("https://ui.example/dashboard");
    reject("not-a-url");
  });

  test("rejects an idle timeout that would preempt the body timeout", () => {
    const build = (server: string) => `
server:
${server}
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`;
    // Bun closes the connection at 10s, so the 30s body timeout could never
    // fire: it would read as protection while providing none.
    expect(() => parseConfig(build("  idle_timeout_seconds: 10\n  body_timeout_ms: 30000"))).toThrow(
      ConfigError,
    );
    // Equal is a coin flip between a clean 408 and a bare connection close,
    // which is the ambiguity the body timeout exists to remove.
    expect(() => parseConfig(build("  idle_timeout_seconds: 30\n  body_timeout_ms: 30000"))).toThrow(
      ConfigError,
    );
    // 0 disables Bun's idle timeout entirely, so nothing preempts anything.
    expect(
      parseConfig(build("  idle_timeout_seconds: 0\n  body_timeout_ms: 600000")).server.body_timeout_ms,
    ).toBe(600_000);
    expect(
      parseConfig(build("  idle_timeout_seconds: 60\n  body_timeout_ms: 30000")).server.idle_timeout_seconds,
    ).toBe(60);
  });

  test("normalises origins to the exact form a browser sends", () => {
    const parse = (value: string) =>
      parseConfig(`
server:
  allow_origin: ["${value}"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`).server.allow_origin;

    // What copying out of an address bar actually gives you.
    expect(parse("https://ui.example/")).toEqual(["https://ui.example"]);
    // Browsers send the host lowercased and drop the default port, so storing
    // anything else would silently never match.
    expect(parse("https://UI.example")).toEqual(["https://ui.example"]);
    expect(parse("https://ui.example:443")).toEqual(["https://ui.example"]);
    expect(parse("http://localhost:5173")).toEqual(["http://localhost:5173"]);
  });

  test("binds loopback unless told otherwise, and lets a container say otherwise", () => {
    const providers = `
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`;
    // Reachable from the network is a decision, not a default.
    expect(parseConfig(providers).server.host).toBe("127.0.0.1");

    // How the shipped example is written, so the container image can widen it
    // with an environment variable rather than the operator editing the file.
    const templated = `server:\n  host: \${TINYROUTER_HOST:-127.0.0.1}${providers}`;
    expect(parseConfig(templated, {}).server.host).toBe("127.0.0.1");
    expect(parseConfig(templated, { TINYROUTER_HOST: "0.0.0.0" }).server.host).toBe("0.0.0.0");
  });

  test("refuses to protect the observability endpoints with no key to check", () => {
    const providers = `
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`;
    // authorized() waves everything through when api_key is unset, so the flag
    // alone would read as protection while providing none.
    expect(() => parseConfig(`server:\n  protect_observability: true${providers}`)).toThrow(ConfigError);
    expect(
      parseConfig(`server:\n  api_key: k\n  protect_observability: true${providers}`).server
        .protect_observability,
    ).toBe(true);
  });

  test("accepts a set of named API keys, or one unnamed, never both", () => {
    const providers = `
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`;
    const named = parseConfig(
      `server:\n  api_keys:\n    alice: \${ALICE_KEY}\n    ci: ci-secret${providers}`,
      { ALICE_KEY: "alice-secret" },
    );
    expect(named.server.api_keys).toEqual({ alice: "alice-secret", ci: "ci-secret" });

    // Two ways to say who may call is one way too many: which wins would be a
    // guess, and guessing wrong on an auth setting is the expensive kind.
    expect(() => parseConfig(`server:\n  api_key: single\n  api_keys:\n    alice: a${providers}`)).toThrow(
      ConfigError,
    );

    // An empty set reads as "these people may call" while naming nobody.
    expect(() => parseConfig(`server:\n  api_keys: {}${providers}`)).toThrow(ConfigError);

    // The single key keeps working exactly as before.
    expect(parseConfig(`server:\n  api_key: single${providers}`).server.api_key).toBe("single");
  });

  test("refuses to let two names share one secret", () => {
    const providers = `
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
`;
    // Revoking alice would not revoke access while the same string still opens
    // the door under another name - the one operation named keys exist for.
    expect(() => parseConfig(`server:\n  api_keys:\n    alice: same\n    bob: same${providers}`)).toThrow(
      ConfigError,
    );
    expect(
      Object.keys(
        parseConfig(`server:\n  api_keys:\n    alice: one\n    bob: two${providers}`).server.api_keys ?? {},
      ),
    ).toEqual(["alice", "bob"]);
  });

  test("redacts every API key while keeping the names", () => {
    const config = parseConfig(`
server:
  api_keys:
    alice: alice-secret
    ci: ci-secret
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
    api_key: provider-secret
`);
    // This output exists so a configuration can be pasted into an issue.
    const dumped = JSON.stringify(redactConfig(config));
    expect(dumped).not.toContain("alice-secret");
    expect(dumped).not.toContain("ci-secret");
    expect(dumped).not.toContain("provider-secret");
    expect(dumped).toContain("alice");
    expect(dumped).toContain("ci");
  });
});
