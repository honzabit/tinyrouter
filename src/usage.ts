export interface TokenUsage {
  prompt: number;
  completion: number;
}

// Bodies are observed, never buffered whole: a completion is read through a
// bounded window and a stream is scanned frame by frame, so a long response
// costs the same memory as a short one.
const MAX_BUFFERED_BYTES = 1_000_000;

function readUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const record = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const prompt = typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
  const completion = typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
  return prompt === 0 && completion === 0 ? undefined : { prompt, completion };
}

function parseUsageFrame(frame: string): TokenUsage | undefined {
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") continue;
    try {
      const usage = readUsage(JSON.parse(data));
      if (usage !== undefined) return usage;
    } catch {
      // A frame that is not JSON carries no usage; keep scanning.
    }
  }
  return undefined;
}

// Passes the body through untouched while watching it for the usage the
// provider reported, so accounting never changes what the client receives.
// Streaming requests only carry usage when the client asks for it, so a stream
// without it is reported as no usage rather than as zero.
export function observeUsage(response: Response, record: (usage: TokenUsage) => void): Response {
  if (response.body === null) return response;
  const sse = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let buffered = 0;
  let found: TokenUsage | undefined;

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (buffered > MAX_BUFFERED_BYTES) return;
        buffered += chunk.byteLength;
        buffer += decoder.decode(chunk, { stream: true });
        if (!sse) return;
        // Keep only the trailing partial frame so memory stays bounded.
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const usage = parseUsageFrame(frame);
          if (usage !== undefined) found = usage;
        }
      },
      flush() {
        buffer += decoder.decode();
        if (buffered <= MAX_BUFFERED_BYTES) {
          if (sse) {
            const usage = parseUsageFrame(buffer);
            if (usage !== undefined) found = usage;
          } else {
            try {
              found = readUsage(JSON.parse(buffer));
            } catch {
              // A truncated or non-JSON body carries no usage.
            }
          }
        }
        if (found !== undefined) record(found);
      },
    }),
  );

  return new Response(body, { status: response.status, headers: response.headers });
}
