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
