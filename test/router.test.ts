import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../src/breaker.ts";
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

describe("circuit breaking", () => {
  const breakerConfig = () =>
    parseConfig(`
routing:
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  down:
    type: openai-compatible
    base_url: https://down.test/v1
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [down/model-a, backup/model-b]
`);

  test("tries a cooling target last instead of first", async () => {
    const config = breakerConfig();
    const calls: string[] = [];
    const metrics = new Metrics();
    const router = new Router(
      config,
      createAdapters(config),
      metrics,
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host === "down.test") return Response.json({ error: { message: "boom" } }, { status: 503 });
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    // Two requests trip the breaker after two consecutive 503s.
    await router.route(input, new AbortController().signal);
    await router.route(input, new AbortController().signal);
    calls.length = 0;

    const result = await router.route(input, new AbortController().signal);
    // The healthy target serves, so the cooling one costs nothing at all.
    expect(calls).toEqual(["backup.test"]);
    expect(result.target.providerId).toBe("backup");
  });

  test("still uses a cooling target when no other target can serve", async () => {
    const config = parseConfig(`
routing:
  circuit_breaker:
    failures: 1
    cooldown_ms: 60000
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
    providers: [local]
`);
    const calls: string[] = [];
    let cloudHealthy = false;
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host === "cloud.test" && !cloudHealthy) {
          return Response.json({ error: { message: "boom" } }, { status: 503 });
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    // Only cloud fails, so cloud's circuit opens while local's stays closed.
    await router.route(input, new AbortController().signal);
    cloudHealthy = true;
    calls.length = 0;
    const result = await router.route(
      { model: "smart", messages: [{ role: "user", content: "a@b.co" }] },
      new AbortController().signal,
    );
    // local is blocked for this content, so a cooling cloud must still be
    // tried rather than failing a request it could serve.
    expect(result.target.providerId).toBe("cloud");
    expect(calls).toEqual(["cloud.test"]);
  });

  test("a success closes the circuit again", async () => {
    const config = breakerConfig();
    let now = 1_000;
    // A fake clock lets the cooldown elapse so the probe path is reachable.
    const breaker = new CircuitBreaker({ failures: 2, cooldown_ms: 5_000 }, () => now);
    let healthy = false;
    const calls: string[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host === "down.test" && !healthy) {
          return Response.json({ error: { message: "boom" } }, { status: 503 });
        }
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
      breaker,
    );

    await router.route(input, new AbortController().signal);
    await router.route(input, new AbortController().signal);
    expect(breaker.isOpen("down")).toBe(true);

    // The cooldown elapses and the provider recovers: the probe must close the
    // circuit, not merely be allowed through once.
    now += 5_000;
    healthy = true;
    const probe = await router.route(input, new AbortController().signal);
    expect(probe.target.providerId).toBe("down");
    // Reading it is what makes it a recovery: the server hands the body to the
    // client, and it is delivering one that proves the provider is back.
    await probe.response.text();
    expect(breaker.isOpen("down")).toBe(false);

    // Closed for good: one later failure must not reopen it immediately.
    healthy = false;
    calls.length = 0;
    await router.route(input, new AbortController().signal);
    expect(calls[0]).toBe("down.test");
    expect(breaker.isOpen("down")).toBe(false);
  });

  test("a client cancelling its own request never blames the provider", async () => {
    const config = parseConfig(`
routing:
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  healthy:
    type: openai-compatible
    base_url: https://healthy.test/v1
routes:
  smart: [healthy/model-a]
`);
    const breaker = new CircuitBreaker({ failures: 2, cooldown_ms: 60_000 });
    const metrics = new Metrics();
    const router = new Router(
      config,
      createAdapters(config),
      metrics,
      // Healthy but slow: it settles only when the request is aborted, which
      // is what a client pressing stop causes.
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        }),
      async () => {},
      breaker,
    );

    for (let index = 0; index < 2; index += 1) {
      const client = new AbortController();
      const pending = router.route(input, client.signal);
      setTimeout(() => client.abort(new Error("client went away")), 5);
      await expect(pending).rejects.toMatchObject({ status: 499, code: "client_closed_request" });
    }

    // The provider did nothing wrong, so it must not be demoted for everyone
    // else, and its attempt counters must not show phantom failures.
    expect(breaker.isOpen("healthy")).toBe(false);
    expect(metrics.render()).not.toContain('provider="healthy"');
  });

  test("routes a target whose cooldown expires while the route is being ordered", async () => {
    const config = parseConfig(`
routing:
  circuit_breaker:
    failures: 1
    cooldown_ms: 100
providers:
  only:
    type: openai-compatible
    base_url: https://only.test/v1
routes:
  smart: [only/model-a]
`);
    // A clock that ticks across the cooldown boundary: reading it more than
    // once while ordering the route must not lose the target.
    const ticks = [1_000, 1_099, 1_100, 1_100];
    let tick = 0;
    const breaker = new CircuitBreaker(
      { failures: 1, cooldown_ms: 100 },
      () => ticks[Math.min(tick++, ticks.length - 1)] as number,
    );
    breaker.recordFailure("only");

    let upstreamCalls = 0;
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        upstreamCalls += 1;
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
      breaker,
    );

    const result = await router.route(input, new AbortController().signal);
    expect(result.target.label).toBe("only/model-a");
    expect(upstreamCalls).toBe(1);
  });

  test("a server error still counts even when it is not retryable", async () => {
    const config = parseConfig(`
routing:
  retry_statuses: [429]
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  down:
    type: openai-compatible
    base_url: https://down.test/v1
routes:
  smart: [down/model-a]
`);
    const breaker = new CircuitBreaker({ failures: 2, cooldown_ms: 60_000 });
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => Response.json({ error: { message: "boom" } }, { status: 500 }),
      async () => {},
      breaker,
    );

    // 500 is excluded from retry_statuses here, but a server error is still a
    // provider failure and must not be read as proof of health.
    for (let index = 0; index < 2; index += 1) {
      await expect(router.route(input, new AbortController().signal)).rejects.toBeInstanceOf(GatewayError);
    }
    expect(breaker.isOpen("down")).toBe(true);
  });

  test("counts one failure per request even when retries repeat it", async () => {
    const config = parseConfig(`
routing:
  retries: 2
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  down:
    type: openai-compatible
    base_url: https://down.test/v1
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [down/model-a, backup/model-b]
`);
    const calls: string[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host === "down.test") return Response.json({ error: { message: "boom" } }, { status: 503 });
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    // One request makes three attempts against the dead target; that is one
    // failing request, not three, so a threshold of two must not trip yet.
    await router.route(input, new AbortController().signal);
    calls.length = 0;
    await router.route(input, new AbortController().signal);
    expect(calls.filter((host) => host === "down.test").length).toBe(3);

    // The second failing request trips it.
    calls.length = 0;
    await router.route(input, new AbortController().signal);
    expect(calls).toEqual(["backup.test"]);
  });

  test("a reachable provider that rejects the request stays closed", async () => {
    const config = parseConfig(`
routing:
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  fussy:
    type: openai-compatible
    base_url: https://fussy.test/v1
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [fussy/model-a, backup/model-b]
`);
    let mode: "retryable" | "rejecting" = "retryable";
    const calls: string[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host !== "fussy.test") return Response.json({ id: "ok", choices: [] });
        return mode === "retryable"
          ? Response.json({ error: { message: "boom" } }, { status: 503 })
          : Response.json({ error: { message: "nope" } }, { status: 400 });
      },
      async () => {},
    );

    // One retryable failure leaves the count one short of the threshold.
    await router.route(input, new AbortController().signal);
    // Answering 400 proves the provider is alive, so it must clear that count
    // rather than leaving it primed to open on the next unrelated blip.
    mode = "rejecting";
    await expect(router.route(input, new AbortController().signal)).rejects.toBeInstanceOf(GatewayError);
    mode = "retryable";
    await router.route(input, new AbortController().signal);
    // Without clearing, this second retryable failure would have opened the
    // circuit and the next request would skip straight to backup.
    calls.length = 0;
    await router.route(input, new AbortController().signal);
    expect(calls[0]).toBe("fussy.test");
  });

  test("a provider that only ever succeeds on its own retry still opens", async () => {
    const config = parseConfig(`
routing:
  retries: 1
  backoff_initial_ms: 0
  backoff_max_ms: 0
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  flaky:
    type: openai-compatible
    base_url: https://flaky.test/v1
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [flaky/model-a, backup/model-b]
`);
    let flakyCalls = 0;
    const calls: string[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host !== "flaky.test") return Response.json({ id: "ok", choices: [] });
        flakyCalls += 1;
        // Fails the first attempt of every request and answers the retry.
        return flakyCalls % 2 === 1
          ? Response.json({ error: { message: "overloaded" } }, { status: 503 })
          : Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    await router.route(input, new AbortController().signal);
    await router.route(input, new AbortController().signal);
    calls.length = 0;
    await router.route(input, new AbortController().signal);
    // The retry succeeding does not undo the failure that preceded it. This is
    // the case the breaker exists for - a provider whose wasted first attempt
    // costs every request a timeout - so it must not be the case it can never
    // see.
    expect(calls[0]).toBe("backup.test");
  });

  const stallingConfig = () =>
    parseConfig(`
routing:
  circuit_breaker:
    failures: 2
    cooldown_ms: 60000
providers:
  stalling:
    type: openai-compatible
    base_url: https://stalling.test/v1
    timeout_ms: 40
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [stalling/model-a, backup/model-b]
`);

  // Headers at once, one frame, then silence for as long as the client will wait.
  const stallingResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

  test("circuit state follows the clock, not the last event", () => {
    const config = stallingConfig();
    let now = 1_000;
    const breaker = new CircuitBreaker({ failures: 1, cooldown_ms: 5_000 }, () => now);
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => Response.json({ id: "ok", choices: [] }),
      async () => {},
      breaker,
    );

    breaker.recordFailure("stalling");
    const open = () => router.circuitStates().providers.find((p) => p.id === "stalling")?.open;
    expect(open()).toBe(true);

    // Nothing happened - the cooldown merely elapsed. A circuit closes by the
    // clock rather than by an event, so anything that cached this would keep
    // reporting a recovered provider as cooling.
    now += 5_000;
    expect(open()).toBe(false);
  });

  test("a provider that answers and then stalls is demoted too", async () => {
    const config = stallingConfig();
    const calls: string[] = [];
    const router = new Router(config, createAdapters(config), new Metrics(), async (request) => {
      const host = new URL(request.url).hostname;
      calls.push(host);
      return host === "stalling.test" ? stallingResponse() : Response.json({ id: "ok", choices: [] });
    });

    const streamed = { ...input, stream: true };
    for (let index = 0; index < 2; index += 1) {
      const result = await router.route(streamed, new AbortController().signal);
      // The client waits out the stall, which is the cost the breaker exists
      // to stop paying on every request.
      await result.response.text();
    }
    calls.length = 0;
    const result = await router.route(streamed, new AbortController().signal);
    await result.response.text();
    // Prompt headers are not proof a provider works. One that never answers at
    // all is demoted; one that answers and then hangs costs strictly more, so
    // it cannot be the case that escapes.
    expect(calls[0]).toBe("backup.test");
  });

  test("a delivered response clears an earlier failure", async () => {
    const config = stallingConfig();
    const breaker = new CircuitBreaker({ failures: 2, cooldown_ms: 60_000 });
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => Response.json({ id: "ok", choices: [] }),
      async () => {},
      breaker,
    );

    breaker.recordFailure("stalling");
    const result = await router.route(input, new AbortController().signal);
    await result.response.text();
    breaker.recordFailure("stalling");
    // Two failures either side of a response that actually arrived: the one
    // before it is cleared, so this is the first, not the second.
    expect(breaker.isOpen("stalling")).toBe(false);
  });

  test("a stream the client abandons records neither success nor failure", async () => {
    const config = stallingConfig();
    const breaker = new CircuitBreaker({ failures: 2, cooldown_ms: 60_000 });
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => stallingResponse(),
      async () => {},
      breaker,
    );

    breaker.recordFailure("stalling");
    const result = await router.route({ ...input, stream: true }, new AbortController().signal);
    // The client reads part of the answer and closes the tab.
    const reader = result.response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await Bun.sleep(20);
    // Not a failure: leaving is the client's doing, so it must not push the
    // provider toward the threshold on its own.
    expect(breaker.isOpen("stalling")).toBe(false);

    breaker.recordFailure("stalling");
    // Nor a success. Content having arrived is not proof the provider was
    // still working when the reader gave up - a provider that sends one token
    // and then hangs looks exactly like this, and crediting it would clear the
    // strikes of the very provider the breaker exists to demote. So the
    // earlier failure stands and this one is the second.
    expect(breaker.isOpen("stalling")).toBe(true);
  });

  test("a provider that drops the body mid-stream is demoted", async () => {
    const config = stallingConfig();
    const breaker = new CircuitBreaker({ failures: 1, cooldown_ms: 60_000 });
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
              setTimeout(() => controller.error(new Error("connection reset by peer")), 5);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      async () => {},
      breaker,
    );

    const result = await router.route({ ...input, stream: true }, new AbortController().signal);
    await result.response.text().catch(() => {});
    await Bun.sleep(20);
    // A provider that resets every connection part-way through has failed the
    // request as surely as one that stalls.
    expect(breaker.isOpen("stalling")).toBe(true);
  });

  test("counts how response bodies ended, by provider", async () => {
    const config = stallingConfig();
    const metrics = new Metrics();
    const router = new Router(config, createAdapters(config), metrics, async (request) =>
      new URL(request.url).hostname === "stalling.test"
        ? stallingResponse()
        : Response.json({ id: "ok", choices: [] }),
    );

    const stalled = await router.route({ ...input, stream: true }, new AbortController().signal);
    await stalled.response.text();
    await Bun.sleep(20);

    const output = metrics.render();
    // The breaker acts on this outcome, so an operator has to be able to see
    // it: the attempt counter only ever recorded the 200 that preceded it.
    expect(output).toContain(
      'tinyrouter_response_bodies_total{provider="stalling",model="model-a",outcome="stalled"} 1',
    );
    expect(output).toContain(
      'tinyrouter_provider_attempts_total{provider="stalling",model="model-a",status="200"} 1',
    );
  });

  test("a client that gives up during retry backoff is not a provider failure", async () => {
    const config = parseConfig(`
routing:
  retries: 1
  backoff_initial_ms: 500
  backoff_max_ms: 500
providers:
  busy:
    type: openai-compatible
    base_url: https://busy.test/v1
routes:
  smart: [busy/model-a]
`);
    const caller = new AbortController();
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => Response.json({ error: { message: "slow down" } }, { status: 429 }),
      // The client hangs up while the gateway is sleeping before its retry.
      async () => {
        caller.abort(new Error("client went away"));
      },
    );

    const error = (await router
      .route(input, caller.signal)
      .catch((caught: unknown) => caught)) as GatewayError;
    // The identical client action during the fetch itself already reports 499.
    // Which millisecond it lands in must not change what is reported.
    expect(error.status).toBe(499);
    expect(error.type).toBe("client_closed_request");
  });

  test("a client that gives up while backing off from a network error reports 499", async () => {
    const config = parseConfig(`
routing:
  retries: 1
  backoff_initial_ms: 500
  backoff_max_ms: 500
providers:
  broken:
    type: openai-compatible
    base_url: https://broken.test/v1
routes:
  smart: [broken/model-a]
`);
    const caller = new AbortController();
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async () => {
        throw new Error("connection refused");
      },
      async () => {
        caller.abort(new Error("client went away"));
      },
    );

    const error = (await router
      .route(input, caller.signal)
      .catch((caught: unknown) => caught)) as GatewayError;
    expect(error.status).toBe(499);
    expect(error.type).toBe("client_closed_request");
  });

  test("attempts an open target anyway when every target is open", async () => {
    const config = parseConfig(`
routing:
  circuit_breaker:
    failures: 1
    cooldown_ms: 60000
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
        if (calls === 1) return Response.json({ error: { message: "boom" } }, { status: 503 });
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    await expect(router.route(input, new AbortController().signal)).rejects.toBeInstanceOf(GatewayError);
    // The only target is open now, but skipping it would fail a request that
    // can still succeed, so it is tried regardless.
    const result = await router.route(input, new AbortController().signal);
    expect(result.target.providerId).toBe("only");
    expect(calls).toBe(2);
  });

  test("non-retryable failures do not trip the breaker", async () => {
    const config = breakerConfig();
    const calls: string[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        calls.push(new URL(request.url).hostname);
        return Response.json({ error: { message: "bad request" } }, { status: 400 });
      },
      async () => {},
    );

    for (let index = 0; index < 3; index += 1) {
      await expect(router.route(input, new AbortController().signal)).rejects.toBeInstanceOf(GatewayError);
    }
    // A client error says nothing about provider health, so every request
    // still reached the first target.
    expect(calls).toEqual(["down.test", "down.test", "down.test"]);
  });

  test("is disabled by default", async () => {
    const config = parseConfig(`
providers:
  down:
    type: openai-compatible
    base_url: https://down.test/v1
  backup:
    type: openai-compatible
    base_url: https://backup.test/v1
routes:
  smart: [down/model-a, backup/model-b]
`);
    expect(config.routing.circuit_breaker.failures).toBe(0);
    const calls: string[] = [];
    const router = new Router(
      config,
      createAdapters(config),
      new Metrics(),
      async (request) => {
        const host = new URL(request.url).hostname;
        calls.push(host);
        if (host === "down.test") return Response.json({ error: { message: "boom" } }, { status: 503 });
        return Response.json({ id: "ok", choices: [] });
      },
      async () => {},
    );

    for (let index = 0; index < 3; index += 1) {
      await router.route(input, new AbortController().signal);
    }
    expect(calls.filter((host) => host === "down.test").length).toBe(3);
  });
});

describe("token accounting", () => {
  const usageConfig = () =>
    parseConfig(`
providers:
  only:
    type: openai-compatible
    base_url: https://only.test/v1
routes:
  smart: [only/model-a]
`);

  test("counts tokens from a completion against the serving target", async () => {
    const config = usageConfig();
    const metrics = new Metrics();
    const router = new Router(config, createAdapters(config), metrics, async () =>
      Response.json({
        id: "ok",
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      }),
    );

    const result = await router.route(input, new AbortController().signal);
    await result.response.text();
    const output = metrics.render();
    expect(output).toContain('tinyrouter_tokens_total{provider="only",model="model-a",kind="prompt"} 11');
    expect(output).toContain('tinyrouter_tokens_total{provider="only",model="model-a",kind="completion"} 5');
  });

  test("counts tokens from a stream that reports usage", async () => {
    const config = usageConfig();
    const metrics = new Metrics();
    const router = new Router(
      config,
      createAdapters(config),
      metrics,
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":8,"total_tokens":10}}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const result = await router.route({ ...input, stream: true }, new AbortController().signal);
    await result.response.text();
    expect(metrics.render()).toContain(
      'tinyrouter_tokens_total{provider="only",model="model-a",kind="completion"} 8',
    );
  });

  test("records nothing when the response carries no usage", async () => {
    const config = usageConfig();
    const metrics = new Metrics();
    const router = new Router(config, createAdapters(config), metrics, async () =>
      Response.json({ id: "ok", choices: [] }),
    );

    const result = await router.route(input, new AbortController().signal);
    await result.response.text();
    expect(metrics.render()).not.toContain("tinyrouter_tokens_total{");
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
