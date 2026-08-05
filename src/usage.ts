export interface TokenUsage {
  prompt: number;
  completion: number;
}

// A completion can carry `usage` anywhere in the object, so it is read through
// a bounded window. A stream always reports usage last, so only its tail is
// ever needed - which keeps memory flat no matter how long the stream runs.
const MAX_COMPLETION_CHARS = 1_000_000;
const STREAM_TAIL_CHARS = 16_384;

function readUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const record = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const prompt = typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
  const completion = typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
  return prompt === 0 && completion === 0 ? undefined : { prompt, completion };
}

// Scans every `data:` line and keeps the last usage it finds. The first line
// of a tail is usually a fragment, which simply fails to parse.
function lastUsageInStream(text: string): TokenUsage | undefined {
  let found: TokenUsage | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") continue;
    try {
      const usage = readUsage(JSON.parse(data));
      if (usage !== undefined) found = usage;
    } catch {
      // A line that is not JSON carries no usage; keep scanning.
    }
  }
  return found;
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
  let overflowed = false;

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (overflowed) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (sse) {
          if (buffer.length > STREAM_TAIL_CHARS) buffer = buffer.slice(-STREAM_TAIL_CHARS);
        } else if (buffer.length > MAX_COMPLETION_CHARS) {
          // A completion this large is not worth holding on to; report no
          // usage rather than growing without bound.
          overflowed = true;
          buffer = "";
        }
      },
      flush() {
        if (overflowed) return;
        buffer += decoder.decode();
        let found: TokenUsage | undefined;
        if (sse) {
          found = lastUsageInStream(buffer);
        } else {
          try {
            found = readUsage(JSON.parse(buffer));
          } catch {
            // A truncated or non-JSON body carries no usage.
          }
        }
        if (found !== undefined) record(found);
      },
    }),
  );

  return new Response(body, { status: response.status, headers: response.headers });
}
