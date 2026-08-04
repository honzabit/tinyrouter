import { describe, expect, test } from "bun:test";
import { withStallTimeout } from "../src/sse.ts";

const encoder = new TextEncoder();

function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
  cancelled: () => boolean;
} {
  let cancelled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    cancelled: () => cancelled,
  };
}

describe("stall timeout", () => {
  test("passes a healthy stream through unchanged", async () => {
    const source = controlledStream();
    const wrapped = withStallTimeout(source.stream, 500, () => {});
    source.push("data: a\n\n");
    source.push("data: b\n\n");
    source.close();
    expect(await new Response(wrapped).text()).toBe("data: a\n\ndata: b\n\n");
  });

  test("keeps a slow but steady stream alive past the window", async () => {
    const source = controlledStream();
    let stalled = false;
    const wrapped = withStallTimeout(source.stream, 60, () => {
      stalled = true;
    });
    const collected = new Response(wrapped).text();
    // Five gaps of 20ms each: well past the 60ms window in total, but never
    // 60ms of silence, so the window must reset on every chunk.
    for (let index = 0; index < 5; index += 1) {
      await Bun.sleep(20);
      source.push(`data: ${index}\n\n`);
    }
    source.close();
    const text = await collected;
    expect(stalled).toBe(false);
    expect(text).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n");
  });

  test("terminates a stalled stream with an error frame and cancels upstream", async () => {
    const source = controlledStream();
    let stalled = false;
    const wrapped = withStallTimeout(source.stream, 40, () => {
      stalled = true;
    });
    source.push("data: first\n\n");
    const text = await new Response(wrapped).text();
    expect(text).toStartWith("data: first\n\n");
    expect(text).toContain("provider_timeout_error");
    expect(text).toEndWith("data: [DONE]\n\n");
    expect(stalled).toBe(true);
    expect(source.cancelled()).toBe(true);
  });

  test("does not report a stall after the stream ends normally", async () => {
    const source = controlledStream();
    let stalled = false;
    const wrapped = withStallTimeout(source.stream, 30, () => {
      stalled = true;
    });
    source.push("data: only\n\n");
    source.close();
    await new Response(wrapped).text();
    await Bun.sleep(80);
    expect(stalled).toBe(false);
  });

  test("does not report a stall when the client cancels", async () => {
    const source = controlledStream();
    let stalled = false;
    const wrapped = withStallTimeout(source.stream, 30, () => {
      stalled = true;
    });
    source.push("data: only\n\n");
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(80);
    expect(stalled).toBe(false);
    expect(source.cancelled()).toBe(true);
  });
});
