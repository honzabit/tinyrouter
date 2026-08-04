import type { JsonValue } from "type-fest";

export interface SseEvent {
  event?: string;
  data: string;
}

const encoder = new TextEncoder();

export function formatSse(data: JsonValue, event?: string): Uint8Array {
  const prefix = event === undefined ? "" : `event: ${event}\n`;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return encoder.encode(`${prefix}data: ${payload}\n\n`);
}

export function mapSseStream(
  source: ReadableStream<Uint8Array>,
  transform: (event: SseEvent) => Uint8Array[],
  flush?: () => Uint8Array[],
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";

  function parseFrame(frame: string): SseEvent | undefined {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trimStart();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return undefined;
    return { ...(event === undefined ? {} : { event }), data: data.join("\n") };
  }

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = parseFrame(frame);
          if (event === undefined) continue;
          for (const output of transform(event)) controller.enqueue(output);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim() !== "") {
          const event = parseFrame(buffer);
          if (event !== undefined) {
            for (const output of transform(event)) controller.enqueue(output);
          }
        }
        if (flush !== undefined) {
          for (const output of flush()) controller.enqueue(output);
        }
      },
    }),
  );
}
