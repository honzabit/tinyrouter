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

// A provider that returns headers and then goes silent would otherwise hold
// the client connection open forever, because the request timeout only bounds
// the wait for those headers. This bounds the gap between body chunks too, so
// a provider has to keep making progress to keep the connection. Any byte
// counts as progress, including the keepalive pings providers send while a
// model is thinking.
export function withStallTimeout(
  source: ReadableStream<Uint8Array>,
  timeoutMs: number,
  onStall: () => void,
  options: { sse?: boolean } = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), timeoutMs);
      });
      const result = await Promise.race([reader.read(), stalled]);
      clear();

      if (result === "stalled") {
        // Release the upstream connection first, then tell the client. A
        // truncated body is the honest outcome for a non-SSE response; an SSE
        // client gets a terminating error event it can actually surface.
        onStall();
        void reader.cancel(new Error("Provider stopped sending data.")).catch(() => {});
        if (options.sse !== false) {
          controller.enqueue(
            formatSse({
              error: {
                message: `Provider sent no data for ${timeoutMs}ms.`,
                type: "provider_timeout_error",
              },
            }),
          );
          controller.enqueue(formatSse("[DONE]"));
        }
        controller.close();
        return;
      }
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      clear();
      void reader.cancel(reason).catch(() => {});
    },
  });
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
