import { z } from "zod";
import { GatewayError } from "./errors.ts";
import type { ChatCompletionRequest, ChatMessage, JsonObject } from "./types.ts";

// Deliberately small and high-precision: deterministic shapes only. Every
// quantifier is bounded, and each pattern starts with either a literal prefix
// or a negative lookbehind that admits one match start per run of candidate
// characters - without that, a long non-matching run makes every position a
// viable start and scanning becomes quadratic. This is pattern redaction, not
// PII detection: no regex finds names or addresses, and the README says so.
const BUILTIN_PATTERNS = {
  email: /(?<![\p{L}\p{N}._%+'-])[\p{L}\p{N}._%+'-]{1,64}@[\p{L}\p{N}.-]{1,251}\.\p{L}{2,24}/u,
  e164_phone: /(?<!\d)\+[1-9]\d{7,14}(?!\d)/u,
  // 13-19 digits, optionally grouped by spaces, non-breaking spaces, or
  // hyphens, which covers Visa/Mastercard 4-4-4-4, Amex 4-6-5, and 13-digit
  // legacy numbers. Shape only - no Luhn check.
  credit_card: /(?<!\d)(?:\d[  -]?){12,18}\d(?!\d)/u,
  anthropic_api_key: /\bsk-ant-[A-Za-z0-9_-]{10,255}/u,
  openai_api_key: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}/u,
  aws_access_key: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  github_token: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/u,
  // The whole PEM block, so redaction removes the key material and not just
  // its header; an unterminated block is redacted through the end of the text.
  private_key: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/u,
};

type BuiltinPattern = keyof typeof BUILTIN_PATTERNS;
const builtinNames = Object.keys(BUILTIN_PATTERNS) as [BuiltinPattern, ...BuiltinPattern[]];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function compilable(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

// A pattern that matches the empty string would insert a marker at every
// position and destroy the message, so it is rejected rather than applied.
function matchesEmpty(pattern: string): boolean {
  return new RegExp(pattern).test("");
}

const commonFilterFields = {
  patterns: z.array(z.enum(builtinNames)).default([]),
  pattern: z
    .string()
    .refine(compilable, "must be a valid regular expression")
    .refine((p) => !compilable(p) || !matchesEmpty(p), "must not match the empty string")
    .optional(),
  name: z.string().regex(identifier).optional(),
  // Which providers the filter applies to; omitted means every provider.
  // Referenced ids are checked against the configuration in config.ts.
  providers: z.array(z.string().regex(identifier)).min(1).optional(),
};

export const filterSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("block"), ...commonFilterFields }),
    z.strictObject({ type: z.literal("redact"), ...commonFilterFields, replacement: z.string().optional() }),
  ])
  .refine(
    (filter) => filter.patterns.length > 0 || filter.pattern !== undefined,
    "needs at least one pattern",
  )
  .refine(
    (filter) => filter.pattern === undefined || filter.name !== undefined,
    "custom patterns need a name",
  );

export type FilterConfig = z.infer<typeof filterSchema>;

export function filtersForProvider(filters: FilterConfig[], providerId: string): FilterConfig[] {
  return filters.filter((filter) => filter.providers === undefined || filter.providers.includes(providerId));
}

interface Rule {
  name: string;
  regex: RegExp;
}

// Redact rules carry the g flag for replace; block rules must not, because
// test() on a g regex resumes from lastIndex and would skip matches on the
// next request.
function compileRules(filter: FilterConfig): Rule[] {
  const suffix = filter.type === "redact" ? "g" : "";
  const rules: Rule[] = filter.patterns.map((name) => ({
    name,
    regex: new RegExp(BUILTIN_PATTERNS[name].source, BUILTIN_PATTERNS[name].flags + suffix),
  }));
  if (filter.pattern !== undefined) {
    const name = filter.name ?? "custom";
    if (matchesEmpty(filter.pattern)) {
      throw new Error(`Filter pattern '${name}' matches the empty string.`);
    }
    rules.push({ name, regex: new RegExp(filter.pattern, suffix) });
  }
  return rules;
}

// Tool-call arguments must stay parseable: splicing a marker into the raw text
// can break the JSON, and the Anthropic adapter answers unparseable arguments
// by sending an empty tool input, silently dropping every field. So redact
// within parsed values instead, and fall back to raw text when the arguments
// are not JSON to begin with.
function mapJsonText(text: string, map: (text: string) => string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return map(text);
  }
  let changed = false;
  const mapValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      const mapped = map(value);
      if (mapped !== value) changed = true;
      return mapped;
    }
    // A redacted number cannot stay a number; a string keeps the JSON valid
    // and the surrounding fields intact.
    if (typeof value === "number" || typeof value === "boolean") {
      const source = String(value);
      const mapped = map(source);
      if (mapped === source) return value;
      changed = true;
      return mapped;
    }
    if (Array.isArray(value)) return value.map(mapValue);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValue(item)]));
    }
    return value;
  };
  const result = mapValue(parsed);
  // Re-serializing normalizes whitespace, so only do it when a rule fired.
  return changed ? JSON.stringify(result) : text;
}

// Filters see content-bearing text only: string content, the text of text
// parts, and tool-call arguments (both the current `tool_calls` shape and the
// legacy `function_call` one). Structural fields - roles, names, ids, image
// URLs - are never scanned, and fields outside `messages` are never touched.
// Returns the original message when no text changed, so an unmatched request
// is forwarded without being rebuilt.
function mapMessage(message: ChatMessage, map: (text: string) => string): ChatMessage {
  const next: ChatMessage = { ...message };
  let changed = false;

  if (typeof next.content === "string") {
    const mapped = map(next.content);
    if (mapped !== next.content) {
      next.content = mapped;
      changed = true;
    }
  } else if (Array.isArray(next.content)) {
    let partChanged = false;
    const parts = next.content.map((part) => {
      if (part === null || typeof part !== "object") return part;
      const record = part as JsonObject;
      if (record.type !== "text" || typeof record.text !== "string") return part;
      const mapped = map(record.text);
      if (mapped === record.text) return part;
      partChanged = true;
      return { ...record, text: mapped };
    });
    if (partChanged) {
      next.content = parts;
      changed = true;
    }
  }

  if (next.tool_calls !== undefined) {
    let callChanged = false;
    const calls = next.tool_calls.map((call) => {
      const mapped = mapJsonText(call.function.arguments, map);
      if (mapped === call.function.arguments) return call;
      callChanged = true;
      return { ...call, function: { ...call.function, arguments: mapped } };
    });
    if (callChanged) {
      next.tool_calls = calls;
      changed = true;
    }
  }

  const legacy = next.function_call;
  if (legacy !== null && typeof legacy === "object") {
    const call = legacy as JsonObject;
    if (typeof call.arguments === "string") {
      const mapped = mapJsonText(call.arguments, map);
      if (mapped !== call.arguments) {
        next.function_call = { ...call, arguments: mapped };
        changed = true;
      }
    }
  }

  return changed ? next : message;
}

// Filters run in configured order, once per request per provider, in a single
// pass over each message: every rule is folded over each piece of text, and a
// message is rebuilt only if some rule actually changed it. Blocks name the
// rule but never echo what matched.
export function createFilterChain(
  filters: FilterConfig[],
): (input: ChatCompletionRequest) => { input: ChatCompletionRequest; redactions: number } {
  if (filters.length === 0) return (input) => ({ input, redactions: 0 });
  const steps = filters.flatMap((filter) =>
    compileRules(filter).map((rule) => ({
      rule,
      marker: filter.type === "block" ? undefined : (filter.replacement ?? `[redacted:${rule.name}]`),
    })),
  );

  return (input) => {
    let redactions = 0;
    const apply = (text: string): string => {
      let result = text;
      for (const { rule, marker } of steps) {
        if (marker === undefined) {
          if (rule.regex.test(result)) {
            throw new GatewayError({
              message: `Request blocked by content filter '${rule.name}'.`,
              status: 400,
              type: "invalid_request_error",
              code: "blocked_by_filter",
            });
          }
          continue;
        }
        result = result.replace(rule.regex, () => {
          redactions += 1;
          return marker;
        });
      }
      return result;
    };

    let changed = false;
    const messages = input.messages.map((message) => {
      const next = mapMessage(message, apply);
      if (next === message) return message;
      changed = true;
      return next;
    });
    return { input: changed ? { ...input, messages } : input, redactions };
  };
}
