import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { parseConfig } from "../src/config.ts";
import { silentLogger } from "../src/logger.ts";
import { createGateway } from "../src/server.ts";

function createTestGateway() {
  const config = parseConfig(`
server:
  api_key: gateway-secret
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
  return createGateway(config, {
    logger: silentLogger,
    fetch: async () =>
      Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
  });
}

describe("HTTP gateway", () => {
  test("exposes health, readiness, models, and metrics", async () => {
    const gateway = createTestGateway();
    expect((await gateway.fetch(new Request("http://test/healthz"))).status).toBe(200);
    expect((await gateway.fetch(new Request("http://test/readyz"))).status).toBe(200);

    const modelsResponse = await gateway.fetch(
      new Request("http://test/v1/models", {
        headers: { authorization: "Bearer gateway-secret" },
      }),
    );
    const models = (await modelsResponse.json()) as { data: Array<{ id: string }> };
    expect(models.data.map((model) => model.id)).toContain("fast");
    expect(models.data.map((model) => model.id)).toContain("mock/model-a");

    const metrics = await (await gateway.fetch(new Request("http://test/metrics"))).text();
    expect(metrics).toContain("tinyrouter_uptime_seconds");
  });

  test("reports the package version at the root endpoint", async () => {
    const gateway = createTestGateway();
    const body = (await (await gateway.fetch(new Request("http://test/"))).json()) as {
      name: string;
      version: string;
    };
    expect(body.name).toBe("TinyRouter");
    expect(body.version).toBe(pkg.version);
  });

  test("requires the configured inbound bearer token", async () => {
    const gateway = createTestGateway();
    const response = await gateway.fetch(new Request("http://test/v1/models"));
    expect(response.status).toBe(401);
  });

  test("routes a valid OpenAI-compatible request", async () => {
    const gateway = createTestGateway();
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
          "x-request-id": "request-123",
        },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(response.headers.get("x-tinyrouter-provider")).toBe("mock");
  });

  test("rejects model names containing control characters", async () => {
    const gateway = createTestGateway();
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: JSON.stringify({ model: "fast\u0000", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("enforces max_body_bytes while reading chunked bodies", async () => {
    const config = parseConfig(`
server:
  api_key: gateway-secret
  max_body_bytes: 1024
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({}),
    });

    const oversized = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "x".repeat(2048) }],
        }),
      }),
    );
    expect(oversized.status).toBe(413);

    // A chunked body without content-length must be capped mid-read, not buffered.
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(512));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: endless,
      }),
    );
    expect(streamed.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  test("applies redact filters before routing and reports the count", async () => {
    const config = parseConfig(`
server:
  api_key: gateway-secret
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
filters:
  - type: redact
    patterns: [email]
`);
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async (request) => {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return Response.json({ id: "ok", choices: [] });
      },
    });

    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "contact jane@example.com" }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tinyrouter-redactions")).toBe("1");
    const messages = upstreamBody?.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toBe("contact [redacted:email]");
  });

  test("blocks filtered requests before any provider is called", async () => {
    const config = parseConfig(`
server:
  api_key: gateway-secret
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
filters:
  - type: block
    patterns: [anthropic_api_key]
`);
    let upstreamCalls = 0;
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => {
        upstreamCalls += 1;
        return Response.json({ id: "ok", choices: [] });
      },
    });

    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "my key is sk-ant-abc123def456" }],
        }),
      }),
    );
    const body = (await response.json()) as { error: { type: string; code?: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("blocked_by_filter");
    expect(upstreamCalls).toBe(0);
  });

  test("returns an OpenAI-shaped validation error", async () => {
    const gateway = createTestGateway();
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: JSON.stringify({ model: "fast", messages: [] }),
      }),
    );
    const body = (await response.json()) as { error: { type: string } };
    expect(response.status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });
});
