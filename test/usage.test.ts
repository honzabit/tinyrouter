import { describe, expect, test } from "bun:test";
import { Metrics } from "../src/metrics.ts";
import { observeUsage, type TokenUsage } from "../src/usage.ts";

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(response: Response): Promise<{ body: string; usage: TokenUsage[] }> {
  const usage: TokenUsage[] = [];
  const observed = observeUsage(response, (u) => usage.push(u));
  const body = await observed.text();
  return { body, usage };
}

describe("usage observation", () => {
  test("reads usage from a completion body without altering it", async () => {
    const original = JSON.stringify({
      id: "x",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    });
    const { body, usage } = await collect(
      new Response(original, { headers: { "content-type": "application/json" } }),
    );
    expect(body).toBe(original);
    expect(usage).toEqual([{ prompt: 12, completion: 7 }]);
  });

  test("reads usage from the final chunk of a stream without altering it", async () => {
    const frames =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n' +
      "data: [DONE]\n\n";
    const { body, usage } = await collect(sseResponse(frames));
    expect(body).toBe(frames);
    expect(usage).toEqual([{ prompt: 3, completion: 4 }]);
  });

  test("reports nothing for a stream that carries no usage", async () => {
    const frames = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const { body, usage } = await collect(sseResponse(frames));
    expect(body).toBe(frames);
    expect(usage).toEqual([]);
  });

  test("reports once when a stream repeats usage", async () => {
    const frames =
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12}}\n\n' +
      "data: [DONE]\n\n";
    const { usage } = await collect(sseResponse(frames));
    expect(usage).toEqual([{ prompt: 3, completion: 9 }]);
  });

  test("reads usage from the end of a stream larger than the completion window", async () => {
    // A stream reports usage last, so a long conversation must not outrun the
    // scanner: only the tail of a stream is ever needed.
    const filler = `data: {"choices":[{"delta":{"content":"${"x".repeat(900)}"}}]}\n\n`;
    const chunks = Array.from({ length: 2_000 }, () => filler);
    chunks.push(
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}\n\n',
    );
    chunks.push("data: [DONE]\n\n");
    const expected = chunks.join("");
    expect(expected.length).toBeGreaterThan(1_000_000);

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const { body, usage } = await collect(
      new Response(source, { headers: { "content-type": "text/event-stream" } }),
    );
    expect(body.length).toBe(expected.length);
    expect(usage).toEqual([{ prompt: 5, completion: 6 }]);
  });

  test("ignores malformed or partial bodies rather than throwing", async () => {
    for (const [type, body] of [
      ["application/json", '{"usage": {"prompt_tokens"'],
      ["application/json", '{"choices":[]}'],
      ["text/event-stream", "data: not json\n\n"],
    ] as const) {
      const { body: passed, usage } = await collect(
        new Response(body, { headers: { "content-type": type } }),
      );
      expect(passed).toBe(body);
      expect(usage).toEqual([]);
    }
  });

  test("rejects token counts that are not whole non-negative numbers", async () => {
    for (const raw of [
      '{"usage":{"prompt_tokens":1e999,"completion_tokens":5}}',
      '{"usage":{"prompt_tokens":1.5,"completion_tokens":2}}',
      '{"usage":{"prompt_tokens":-3,"completion_tokens":-4}}',
      '{"usage":{"prompt_tokens":"12","completion_tokens":"7"}}',
    ]) {
      const { usage } = await collect(new Response(raw, { headers: { "content-type": "application/json" } }));
      // A malformed count must be dropped, never folded into a counter it
      // would poison for the life of the process.
      expect(`${raw} -> ${JSON.stringify(usage)}`).toBe(`${raw} -> []`);
    }
  });

  test("keeps the valid half of a partially malformed usage object", async () => {
    const { usage } = await collect(
      new Response('{"usage":{"prompt_tokens":1e999,"completion_tokens":6}}', {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(usage).toEqual([]);
  });

  test("records usage when the client disconnects mid-stream", async () => {
    const frames =
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n' +
      'data: {"choices":[{"delta":{"content":"more"}}]}\n\n';
    const usage: TokenUsage[] = [];
    const observed = observeUsage(sseResponse(frames), (u) => usage.push(u));
    const reader = observed.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await Bun.sleep(20);
    // The provider already produced - and charged for - what was seen.
    expect(usage).toEqual([{ prompt: 9, completion: 4 }]);
  });

  test("records usage when the provider's stream breaks mid-response", async () => {
    const usage: TokenUsage[] = [];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":8}}\n\n',
          ),
        );
        setTimeout(() => controller.error(new Error("connection reset by peer")), 5);
      },
    });
    const observed = observeUsage(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      (u) => usage.push(u),
    );
    // The break still reaches the client - a truncated answer must not look
    // like a complete one - but the tokens behind it were generated and billed.
    await expect(observed.text()).rejects.toThrow();
    expect(usage).toEqual([{ prompt: 7, completion: 8 }]);
  });

  test("finds usage after a single line larger than the retained tail", async () => {
    const huge = `data: {"choices":[{"delta":{"content":"${"y".repeat(200_000)}"}}]}\n\n`;
    const frames = `${huge}data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n`;
    const { usage } = await collect(sseResponse(frames));
    expect(usage).toEqual([{ prompt: 2, completion: 3 }]);
  });

  test("preserves status and statusText", async () => {
    const observed = observeUsage(
      new Response("{}", { status: 201, statusText: "Created", headers: { "x-a": "b" } }),
      () => {},
    );
    expect(observed.status).toBe(201);
    expect(observed.statusText).toBe("Created");
    expect(observed.headers.get("x-a")).toBe("b");
  });

  test("leaves a body-less response alone", async () => {
    const response = new Response(null, { status: 204 });
    expect(observeUsage(response, () => {})).toBe(response);
  });
});

describe("token metrics", () => {
  test("renders token counters per provider, model, and kind", () => {
    const metrics = new Metrics();
    metrics.tokens({ provider: "openai", model: "gpt-5-mini", kind: "prompt" }, 12);
    metrics.tokens({ provider: "openai", model: "gpt-5-mini", kind: "completion" }, 7);
    metrics.tokens({ provider: "openai", model: "gpt-5-mini", kind: "prompt" }, 3);
    const output = metrics.render();
    expect(output).toContain("# TYPE tinyrouter_tokens_total counter");
    expect(output).toContain(
      'tinyrouter_tokens_total{provider="openai",model="gpt-5-mini",kind="prompt"} 15',
    );
    expect(output).toContain(
      'tinyrouter_tokens_total{provider="openai",model="gpt-5-mini",kind="completion"} 7',
    );
  });

  test("ignores non-positive and non-finite counts", () => {
    const metrics = new Metrics();
    metrics.tokens({ provider: "p", model: "m", kind: "prompt" }, 0);
    metrics.tokens({ provider: "p", model: "m", kind: "prompt" }, Number.POSITIVE_INFINITY);
    metrics.tokens({ provider: "p", model: "m", kind: "prompt" }, Number.NaN);
    expect(metrics.render()).not.toContain('kind="prompt"');
  });

  test("keeps the kind label when collapsing overflowing token series", () => {
    const metrics = new Metrics();
    for (let index = 0; index <= 1_000; index += 1) {
      metrics.tokens({ provider: "p", model: `model-${index}`, kind: "completion" }, 2);
    }
    const output = metrics.render();
    // provider and model collapse, but kind must survive so that summing by
    // kind still accounts for the overflowed tokens.
    expect(output).toContain(
      'tinyrouter_tokens_total{provider="__other__",model="__other__",kind="completion"}',
    );
    expect(output).not.toContain('kind="overflow"');
  });
});
