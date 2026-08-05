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

  test("still reports an oversized body as too large when cancelling it fails", async () => {
    const config = parseConfig(`
server:
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

    // Tearing down an already-broken stream can reject. That is the gateway's
    // problem, not a reason to tell the operator the client hung up.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", { method: "POST", body }),
    );
    const payload = (await response.json()) as { error: { code?: string } };
    expect(response.status).toBe(413);
    expect(payload.error.code).toBe("body_too_large");
  });

  test("reads a body delivered in many small chunks", async () => {
    const config = parseConfig(`
server:
  body_timeout_ms: 1000
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    // Chunked encoding lets a client pick the framing, so per-chunk cost has
    // to stay flat: the body limit counts bytes, not chunks.
    const payload = JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const character of payload) controller.enqueue(encoder.encode(character));
        controller.close();
      },
    });
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", { method: "POST", body }),
    );
    expect(response.status).toBe(200);
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

  test("reports a client that disconnects mid-upload as a closed request", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const config = parseConfig(`
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: { log: (record) => logs.push(record as unknown as Record<string, unknown>) },
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"fast","messages":'));
        setTimeout(() => controller.error(new Error("connection reset by peer")), 5);
      },
    });
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", { method: "POST", body }),
    );
    const payload = (await response.json()) as { error: { code?: string } };
    // The same client action one phase later already reports 499; a disconnect
    // while uploading must not masquerade as a gateway fault.
    expect(response.status).toBe(499);
    expect(payload.error.code).toBe("client_closed_request");
    expect(logs.at(-1)?.level).toBe("warn");
  });

  test("answers a cancelled request while its body is arriving", async () => {
    const config = parseConfig(`
server:
  body_timeout_ms: 1000
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    // How a client actually leaves: the signal aborts while the body is still
    // arriving. Stopping cancels the reader, which resolves the pending read
    // as done, so the reason has to be carried separately - reading the abort
    // back off the reader would make this indistinguishable from a body that
    // simply ended.
    const client = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"fast","messages":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    setTimeout(() => client.abort(new Error("client hung up")), 20);
    const startedAt = performance.now();
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        body,
        signal: client.signal,
      }),
    );
    const payload = (await response.json()) as { error: { code?: string } };
    expect(response.status).toBe(499);
    expect(payload.error.code).toBe("client_closed_request");
    // Well inside body_timeout_ms: a leaving client is noticed, not waited out
    // and then reported as a stall.
    expect(performance.now() - startedAt).toBeLessThan(900);
    expect(cancelled).toBe(true);
  });

  test("answers a request whose client left before it was read", async () => {
    const config = parseConfig(`
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    const client = new AbortController();
    client.abort(new Error("client hung up"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"fast","messages":[]}'));
      },
    });
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        body,
        signal: client.signal,
      }),
    );
    const payload = (await response.json()) as { error: { code?: string } };
    expect(response.status).toBe(499);
    expect(payload.error.code).toBe("client_closed_request");
  });

  test("gives up on a request body that stops arriving", async () => {
    const config = parseConfig(`
server:
  body_timeout_ms: 1000
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    // A client that sends part of a body and then goes quiet without closing
    // the connection would otherwise hold the handler open forever.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"fast","messages":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const startedAt = performance.now();
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", { method: "POST", body }),
    );
    expect(response.status).toBe(408);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(cancelled).toBe(true);
  });

  test("accepts a body that arrives slowly but keeps arriving", async () => {
    const config = parseConfig(`
server:
  body_timeout_ms: 1000
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    const parts = ['{"model":"fast",', '"messages":[{"role":"user",', '"content":"hi"}]}'];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of parts) {
          // Long enough that the parts together outlast the bound, so this
          // only passes if each arrival actually restarts the clock.
          await Bun.sleep(700);
          controller.enqueue(new TextEncoder().encode(part));
        }
        controller.close();
      },
    });
    // Total time exceeds the bound; no single gap does, so it must succeed.
    const response = await gateway.fetch(
      new Request("http://test/v1/chat/completions", { method: "POST", body }),
    );
    expect(response.status).toBe(200);
  });

  test("reports circuit breaker state on readyz and in metrics", async () => {
    const config = parseConfig(`
routing:
  circuit_breaker:
    failures: 1
    cooldown_ms: 60000
providers:
  flaky:
    type: openai-compatible
    base_url: https://flaky.test/v1
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  fast: [flaky/model-a, backup/model-b]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async (request) =>
        new URL(request.url).hostname === "flaky.test"
          ? Response.json({ error: { message: "boom" } }, { status: 503 })
          : Response.json({ id: "ok", choices: [] }),
    });

    const before = (await (await gateway.fetch(new Request("http://test/readyz"))).json()) as {
      circuit_breaker: { enabled: boolean; open: string[] };
    };
    expect(before.circuit_breaker).toEqual({ enabled: true, open: [] });

    await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    // 0.4.0 could demote a provider with no way for an operator to see it had.
    const after = (await (await gateway.fetch(new Request("http://test/readyz"))).json()) as {
      status: string;
      circuit_breaker: { enabled: boolean; open: string[] };
    };
    expect(after.circuit_breaker).toEqual({ enabled: true, open: ["flaky"] });
    // Demoted is not removed - the gateway still serves - so readiness must not
    // flip and pull the process out of rotation over it.
    expect(after.status).toBe("ready");

    const metrics = await (await gateway.fetch(new Request("http://test/metrics"))).text();
    expect(metrics).toContain('tinyrouter_circuit_open{provider="flaky"} 1');
    expect(metrics).toContain('tinyrouter_circuit_open{provider="backup"} 0');
  });

  test("shares observability endpoints with configured origins only", async () => {
    const config = parseConfig(`
server:
  api_key: gateway-secret
  allow_origin: ["https://ui.example"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    const allowed = await gateway.fetch(
      new Request("http://test/metrics", { headers: { origin: "https://ui.example" } }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://ui.example");
    // The answer depends on Origin, so a cache must not hand one origin's
    // response to another.
    expect(allowed.headers.get("vary")).toContain("Origin");

    const stranger = await gateway.fetch(
      new Request("http://test/metrics", { headers: { origin: "https://evil.example" } }),
    );
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();

    // Preflight, which is what a browser actually sends before a keyed GET.
    const preflight = await gateway.fetch(
      new Request("http://test/v1/models", {
        method: "OPTIONS",
        headers: { origin: "https://ui.example" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://ui.example");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    // Header auth, never ambient credentials.
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    // A refused key must come back readable, or the browser reports a CORS
    // failure and the operator debugs the wrong problem.
    const refused = await gateway.fetch(
      new Request("http://test/v1/models", { headers: { origin: "https://ui.example" } }),
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("https://ui.example");
  });

  test("never shares the completions endpoint with a browser", async () => {
    const config = parseConfig(`
server:
  allow_origin: ["https://ui.example"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    // api_key is optional, so a gateway can be open on localhost. If a page
    // could reach completions cross-origin it could spend the operator's
    // provider credits; the failed preflight is what stops it.
    const preflight = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "OPTIONS",
        headers: { origin: "https://ui.example" },
      }),
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const posted = await gateway.fetch(
      new Request("http://test/v1/chat/completions", {
        method: "POST",
        headers: { origin: "https://ui.example" },
        body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(posted.status).toBe(200);
    expect(posted.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("sends no CORS headers when no origin is configured", async () => {
    const gateway = createTestGateway();
    const response = await gateway.fetch(
      new Request("http://test/readyz", { headers: { origin: "https://ui.example" } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  test("leaves OPTIONS alone for an operator who never enabled CORS", async () => {
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
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    // Preflight is answered before the auth gate, which is correct only while
    // CORS is switched on. Off, the gate has to keep applying to every method.
    const models = await gateway.fetch(new Request("http://test/v1/models", { method: "OPTIONS" }));
    expect(models.status).toBe(401);
    expect(models.headers.get("access-control-allow-methods")).toBeNull();

    // And nothing about the endpoints changes for someone who never opted in.
    const metrics = await gateway.fetch(new Request("http://test/metrics", { method: "OPTIONS" }));
    expect(metrics.status).toBe(200);
  });

  test("admits every configured origin, not just the first", async () => {
    const config = parseConfig(`
server:
  allow_origin: ["https://a.example", "http://localhost:5173"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    for (const origin of ["https://a.example", "http://localhost:5173"]) {
      const response = await gateway.fetch(new Request("http://test/readyz", { headers: { origin } }));
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  test("lets a browser read the headers it is sent, and the real status of a bad request", async () => {
    const config = parseConfig(`
server:
  api_key: gateway-secret
  allow_origin: ["https://ui.example"]
providers:
  mock:
    type: openai-compatible
    base_url: https://mock.test/v1
routes:
  fast: [mock/model-a]
`);
    const gateway = createGateway(config, {
      logger: silentLogger,
      fetch: async () => Response.json({ id: "ok", choices: [] }),
    });

    const models = await gateway.fetch(
      new Request("http://test/v1/models", {
        headers: { origin: "https://ui.example", authorization: "Bearer gateway-secret" },
      }),
    );
    // x-request-id goes out on the wire, but a cross-origin page cannot read it
    // unless it is exposed - and it is the value that ties a click to a log line.
    expect(models.headers.get("x-request-id")).not.toBeNull();
    expect(models.headers.get("access-control-expose-headers")).toContain("x-request-id");

    // Wrong method on a shared path: the browser should see the 404, not a CORS
    // failure that sends the developer to edit their origin list.
    const wrongMethod = await gateway.fetch(
      new Request("http://test/v1/models", {
        method: "POST",
        headers: { origin: "https://ui.example", authorization: "Bearer gateway-secret" },
      }),
    );
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.headers.get("access-control-allow-origin")).toBe("https://ui.example");
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
