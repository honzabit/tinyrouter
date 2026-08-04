import { describe, expect, test } from "bun:test";
import { formatSse, mapSseStream, type SseEvent } from "../src/sse.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sourceOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(source: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  await new Response(
    mapSseStream(source, (event) => {
      events.push(event);
      return [];
    }),
  ).text();
  return events;
}

describe("sse", () => {
  test("formats JSON payloads, strings, and event names", () => {
    expect(decoder.decode(formatSse({ a: 1 }, "message"))).toBe('event: message\ndata: {"a":1}\n\n');
    expect(decoder.decode(formatSse("[DONE]"))).toBe("data: [DONE]\n\n");
  });

  test("parses CRLF frames and named events", async () => {
    const events = await collect(sourceOf("event: ping\r\ndata: a\r\n\r\n", "data: b\n\n"));
    expect(events).toEqual([{ event: "ping", data: "a" }, { data: "b" }]);
  });

  test("joins multi-line data and reassembles frames split across chunks", async () => {
    const events = await collect(sourceOf("data: a\nda", "ta: b\n\n"));
    expect(events).toEqual([{ data: "a\nb" }]);
  });

  test("ignores frames without data lines", async () => {
    const events = await collect(sourceOf(": keepalive\n\n", "event: ping\n\n", "data: x\n\n"));
    expect(events).toEqual([{ data: "x" }]);
  });

  test("parses a trailing frame without a terminator and appends flush output", async () => {
    const output = await new Response(
      mapSseStream(
        sourceOf("data: tail"),
        (event) => [encoder.encode(`seen:${event.data};`)],
        () => [encoder.encode("flushed")],
      ),
    ).text();
    expect(output).toBe("seen:tail;flushed");
  });
});
