import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { GatewayError } from "../src/errors.ts";
import { Metrics } from "../src/metrics.ts";
import { createAdapters } from "../src/providers/index.ts";
import { type Fetch, parseRetryAfter, Router, retryBackoffMs } from "../src/router.ts";
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
    const router = routerWith(async (request) => {
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
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("connection reset");
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

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
    const router = new Router(config, createAdapters(config), new Metrics(), async (request) => {
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

const singleTargetConfig = (routingYaml: string) =>
  parseConfig(`
routing:
${routingYaml}
providers:
  only:
    type: openai-compatible
    base_url: https://only.test/v1
routes:
  smart: [only/model-a]
`);

describe("retry backoff", () => {
  test("waits the provider's Retry-After between retries of the same target", async () => {
    const config = singleTargetConfig("  retries: 2");
    const waits: number[] = [];
    let calls = 0;
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        calls += 1;
        if (calls < 3) {
          return Response.json(
            { error: { message: "slow down" } },
            { status: 429, headers: { "retry-after": "1" } },
          );
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    const result = await router.route(input, new AbortController().signal);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 1000]);
    expect(result.attempts[0]?.retryDelayMs).toBe(1000);
    expect(result.attempts[2]?.retryDelayMs).toBeUndefined();
  });

  test("applies jittered exponential backoff to connection failures", async () => {
    const config = singleTargetConfig("  retries: 2");
    const waits: number[] = [];
    let calls = 0;
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("connection reset");
        return Response.json({ id: "ok", choices: [] });
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    await router.route(input, new AbortController().signal);
    expect(waits.length).toBe(2);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[0]).toBeLessThanOrEqual(200);
    expect(waits[1]).toBeGreaterThanOrEqual(200);
    expect(waits[1]).toBeLessThanOrEqual(400);
  });

  test("never waits before falling back to a different target", async () => {
    const config = parseConfig(`
providers:
  first:
    type: openai-compatible
    base_url: https://first.test/v1
  second:
    type: openai-compatible
    base_url: https://second.test/v1
routes:
  smart: [first/model-a, second/model-b]
`);
    const waits: number[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        if (new URL(request.url).hostname === "first.test") {
          return Response.json(
            { error: { message: "busy" } },
            { status: 503, headers: { "retry-after": "9" } },
          );
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    const result = await router.route(input, new AbortController().signal);
    expect(result.target.providerId).toBe("second");
    expect(waits).toEqual([]);
  });

  test("backoff_max_ms of 0 restores immediate retries and overrides Retry-After", async () => {
    const config = singleTargetConfig("  retries: 1\n  backoff_max_ms: 0");
    const waits: number[] = [];
    let calls = 0;
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { message: "slow down" } },
            { status: 429, headers: { "retry-after": "5" } },
          );
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    const result = await router.route(input, new AbortController().signal);
    expect(calls).toBe(2);
    expect(waits).toEqual([]);
    expect(result.attempts[0]?.retryDelayMs).toBeUndefined();
  });
});

describe("provider-scoped filters", () => {
  test("filters apply only to their scoped providers, per attempt", async () => {
    const config = parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: https://local.test/v1
  cloud:
    type: openai-compatible
    base_url: https://cloud.test/v1
routes:
  smart: [local/model-a, cloud/model-b]
filters:
  - type: redact
    patterns: [email]
    providers: [cloud]
`);
    const bodies: Record<string, string> = {};
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        const body = (await request.json()) as { messages: Array<{ content: string }> };
        bodies[host] = body.messages[0]?.content ?? "";
        if (host === "local.test") {
          return Response.json({ error: { message: "down" } }, { status: 503 });
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    const result = await router.route(
      { model: "smart", messages: [{ role: "user", content: "mail jane@example.com" }] },
      new AbortController().signal,
    );
    expect(bodies["local.test"]).toBe("mail jane@example.com");
    expect(bodies["cloud.test"]).toBe("mail [redacted:email]");
    expect(result.redactions).toBe(1);
  });

  test("a served target outside every filter scope reports zero redactions", async () => {
    const config = parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: https://local.test/v1
  cloud:
    type: openai-compatible
    base_url: https://cloud.test/v1
routes:
  smart: [local/model-a]
filters:
  - type: redact
    patterns: [email]
    providers: [cloud]
`);
    let upstreamContent = "";
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const body = (await request.json()) as { messages: Array<{ content: string }> };
        upstreamContent = body.messages[0]?.content ?? "";
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    const result = await router.route(
      { model: "smart", messages: [{ role: "user", content: "mail jane@example.com" }] },
      new AbortController().signal,
    );
    expect(upstreamContent).toBe("mail jane@example.com");
    expect(result.redactions).toBe(0);
  });
});

describe("stalled responses", () => {
  const stallConfig = () =>
    parseConfig(`
providers:
  only:
    type: openai-compatible
    base_url: https://only.test/v1
    timeout_ms: 60
routes:
  smart: [only/model-a]
`);

  test("aborts a streaming response whose provider goes silent", async () => {
    const config = stallConfig();
    let upstreamAborted = false;
    const router = new Router(config, createAdapters(config), new Metrics(), async (request) => {
      // Headers arrive, then the provider sends one chunk and stops.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        },
      });
      request.signal.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const result = await router.route({ ...input, stream: true }, new AbortController().signal);
    const text = await result.response.text();
    expect(text).toStartWith("data: first\n\n");
    expect(text).toContain("provider_timeout_error");
    expect(upstreamAborted).toBe(true);
  });

  test("aborts a non-streaming response whose body never completes", async () => {
    const config = stallConfig();
    const router = new Router(config, createAdapters(config), new Metrics(), async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"partial"'));
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    });

    const result = await router.route(input, new AbortController().signal);
    // The body must end rather than hang; it is truncated, which the client
    // sees as invalid JSON instead of an open connection forever.
    const text = await result.response.text();
    expect(text).toStartWith('{"id":"partial"');
  });

  test("leaves a healthy streaming response untouched", async () => {
    const config = stallConfig();
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () =>
        new Response("data: a\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    );

    const result = await router.route({ ...input, stream: true }, new AbortController().signal);
    expect(await result.response.text()).toBe("data: a\n\ndata: [DONE]\n\n");
  });
});

describe("filter blocking", () => {
  const blockConfig = (scope: string) =>
    parseConfig(`
providers:
  cloud:
    type: openai-compatible
    base_url: https://cloud.test/v1
  local:
    type: openai-compatible
    base_url: https://local.test/v1
routes:
  smart: [cloud/a, local/b]
filters:
  - type: block
    patterns: [email]
${scope}
`);

  test("a scoped block skips that target and falls back to one outside the scope", async () => {
    const config = blockConfig("    providers: [cloud]");
    const calls: string[] = [];
    const metrics = new Metrics();
    const router = new Router(
      config,
      createAdapters(config),
      metrics,
      async (request) => {
        calls.push(new URL(request.url).hostname);
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    const result = await router.route(
      { model: "smart", messages: [{ role: "user", content: "a@b.co" }] },
      new AbortController().signal,
    );
    expect(result.target.providerId).toBe("local");
    expect(calls).toEqual(["local.test"]);
    // The blocked target is recorded, but never as an upstream provider attempt.
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["blocked", "success"]);
    expect(metrics.render()).not.toContain('provider="cloud"');
  });

  test("an unscoped block fails the request once no target can serve it", async () => {
    const config = blockConfig("");
    let calls = 0;
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        calls += 1;
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    await expect(
      router.route(
        { model: "smart", messages: [{ role: "user", content: "a@b.co" }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 400, code: "blocked_by_filter" });
    expect(calls).toBe(0);
  });

  test("a scoped block does not mask a real failure of another target", async () => {
    const config = parseConfig(`
providers:
  local:
    type: openai-compatible
    base_url: https://local.test/v1
  cloud:
    type: openai-compatible
    base_url: https://cloud.test/v1
routes:
  smart: [local/a, cloud/b]
filters:
  - type: block
    patterns: [email]
    providers: [cloud]
`);
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => Response.json({ error: { message: "down" } }, { status: 503 }),
      async () => {},
    );

    // local really failed; the block on the untried cloud target must not
    // rewrite that into a client-side 400.
    await expect(
      router.route(
        { model: "smart", messages: [{ role: "user", content: "a@b.co" }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  test("records redactions per attempt, including attempts that did not serve", async () => {
    const config = parseConfig(`
providers:
  cloud:
    type: openai-compatible
    base_url: https://cloud.test/v1
  local:
    type: openai-compatible
    base_url: https://local.test/v1
routes:
  smart: [cloud/a, local/b]
filters:
  - type: redact
    patterns: [email]
    providers: [cloud]
`);
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        if (new URL(request.url).hostname === "cloud.test") {
          return Response.json({ error: { message: "down" } }, { status: 503 });
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    const result = await router.route(
      { model: "smart", messages: [{ role: "user", content: "mail a@b.co" }] },
      new AbortController().signal,
    );
    expect(result.target.providerId).toBe("local");
    expect(result.redactions).toBe(0);
    expect(result.attempts[0]?.redactions).toBe(1);
    expect(result.attempts[1]?.redactions).toBeUndefined();
  });
});

describe("retry backoff math", () => {
  test("parseRetryAfter reads retry-after-ms, seconds, and HTTP dates", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250" }), 0)).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), 0)).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after": "2" }), 0)).toBe(2000);
    expect(parseRetryAfter(new Headers({ "retry-after": "1.5" }), 0)).toBe(1500);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }), now)).toBe(5000);
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:00 GMT" }), now + 1)).toBe(0);
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }), 0)).toBeUndefined();
    expect(parseRetryAfter(new Headers({ "retry-after": "-2" }), 0)).toBeUndefined();
    expect(parseRetryAfter(new Headers(), 0)).toBeUndefined();
  });

  test("retryBackoffMs grows exponentially, honors Retry-After, and clamps to the maximum", () => {
    const top = () => 1;
    const bottom = () => 0;
    expect(retryBackoffMs({ attempt: 0, initialMs: 200, maxMs: 2000, random: top })).toBe(200);
    expect(retryBackoffMs({ attempt: 0, initialMs: 200, maxMs: 2000, random: bottom })).toBe(100);
    expect(retryBackoffMs({ attempt: 2, initialMs: 200, maxMs: 2000, random: top })).toBe(800);
    expect(retryBackoffMs({ attempt: 6, initialMs: 200, maxMs: 2000, random: top })).toBe(2000);
    expect(retryBackoffMs({ attempt: 0, initialMs: 200, maxMs: 2000, retryAfterMs: 1500, random: top })).toBe(
      1500,
    );
    expect(
      retryBackoffMs({ attempt: 0, initialMs: 200, maxMs: 2000, retryAfterMs: 60_000, random: top }),
    ).toBe(2000);
    expect(retryBackoffMs({ attempt: 0, initialMs: 0, maxMs: 2000, random: top })).toBe(0);
    expect(retryBackoffMs({ attempt: 0, initialMs: 200, maxMs: 0, retryAfterMs: 5000, random: top })).toBe(0);
  });
});
