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
});
