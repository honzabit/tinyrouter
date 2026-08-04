import { describe, expect, test } from "bun:test";
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
    const models = (await modelsResponse.json()) as any;
    expect(models.data.map((model: any) => model.id)).toContain("fast");
    expect(models.data.map((model: any) => model.id)).toContain("mock/model-a");

    const metrics = await (await gateway.fetch(new Request("http://test/metrics"))).text();
    expect(metrics).toContain("tinyrouter_uptime_seconds");
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

  test("returns an OpenAI-shaped validation error", async () => {
    const gateway = createTestGateway();
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret" },
        body: JSON.stringify({ model: "fast", messages: [] }),
      }),
    );
    const body = (await response.json()) as any;
    expect(response.status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });
});
