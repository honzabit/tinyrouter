import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { GatewayError } from "../src/errors.ts";
import { Metrics } from "../src/metrics.ts";
import { createAdapters } from "../src/providers/index.ts";
import { Router, type Fetch } from "../src/router.ts";
import type { ChatCompletionRequest } from "../src/types.ts";

const input: ChatCompletionRequest = {
  model: "smart",
  messages: [{ role: "user", content: "Hello" }],
};

function routerWith(fetchFn: Fetch) {
  const config = parseConfig(`
routing:
  retries: 0
providers:
  first:
    type: openai-compatible
    base_url: https://first.test/v1
    api_key: first-key
  second:
    type: openai-compatible
    base_url: https://second.test/v1
    api_key: second-key
routes:
  smart: [first/model-a, second/model-b]
`);
  return new Router(config, createAdapters(config), new Metrics(), fetchFn);
}

describe("router", () => {
  test("falls back in configured order on a retryable response", async () => {
    const calls: Array<{ url: string; authorization: string | null; model: unknown }> = [];
    const router = routerWith(async (requestInfo) => {
      const request = requestInfo as Request;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        model: body.model,
      });
      if (new URL(request.url).hostname === "first.test") {
        return Response.json({ error: { message: "busy" } }, { status: 503 });
      }
      return Response.json({
        id: "chatcmpl-ok",
        object: "chat.completion",
        created: 1,
        model: "model-b",
        choices: [],
      });
    });

    const result = await router.route(input, new AbortController().signal);
    expect(result.target.label).toBe("second/model-b");
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["fallback", "success"]);
    expect(calls).toEqual([
      {
        url: "https://first.test/v1/chat/completions",
        authorization: "Bearer first-key",
        model: "model-a",
      },
      {
        url: "https://second.test/v1/chat/completions",
        authorization: "Bearer second-key",
        model: "model-b",
      },
    ]);
  });

  test("does not fall back on a non-retryable request error", async () => {
    let calls = 0;
    const router = routerWith(async () => {
      calls += 1;
      return Response.json({ error: { message: "bad input" } }, { status: 400 });
    });

    await expect(router.route(input, new AbortController().signal)).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toBe(1);
  });

  test("accepts direct provider/model identifiers", () => {
    const router = routerWith(async () => Response.json({}));
    expect(router.resolve("first/arbitrary/model")).toEqual([
      { providerId: "first", model: "arbitrary/model", label: "first/arbitrary/model" },
    ]);
  });

  test("retries the same target before falling back", async () => {
    const config = parseConfig(`
routing:
  retries: 1
providers:
  only:
    type: openai-compatible
    base_url: https://only.test/v1
routes:
  smart: [only/model-a]
`);
    let calls = 0;
    const router = new Router(config, createAdapters(config), new Metrics(), async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return Response.json({ id: "ok", choices: [] });
    });

    const result = await router.route(input, new AbortController().signal);
    expect(calls).toBe(2);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["retry", "success"]);
  });

  test("commits to the provider after a successful streaming response", async () => {
    let calls = 0;
    const router = routerWith(async () => {
      calls += 1;
      return new Response("data: first\n\ndata: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const result = await router.route({ ...input, stream: true }, new AbortController().signal);
    expect(await result.response.text()).toContain("data: first");
    expect(result.target.providerId).toBe("first");
    expect(calls).toBe(1);
  });

  test("falls back when a provider exceeds its response timeout", async () => {
    const config = parseConfig(`
providers:
  slow:
    type: openai-compatible
    base_url: https://slow.test/v1
    timeout_ms: 5
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [slow/model-a, backup/model-b]
`);
    const router = new Router(config, createAdapters(config), new Metrics(), async (requestInfo) => {
      const request = requestInfo as Request;
      if (new URL(request.url).hostname === "slow.test") {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      return Response.json({ id: "ok", choices: [] });
    });

    const result = await router.route(input, new AbortController().signal);
    expect(result.target.providerId).toBe("backup");
    expect(result.attempts[0]?.errorType).toBe("provider_timeout_error");
  });
});
