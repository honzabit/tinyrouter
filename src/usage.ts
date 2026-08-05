export interface TokenUsage {
  prompt: number;
  completion: number;
}

// Only the tail of a body is retained. Providers report usage last - at the end
// of a completion object, and in the final frame of a stream - so this bounds
// memory to a constant per request regardless of how much was generated, and
// works the same for a stream and a completion.
const TAIL_CHARS = 65_536;

// Counts arrive from a provider, which is not trusted input: a value that is
// not a whole non-negative number would otherwise be folded into a counter it
// poisons for the life of the process.
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
}

function toUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const prompt = tokenCount(record.prompt_tokens);
  const completion = tokenCount(record.completion_tokens);
  if (prompt < 0 || completion < 0) return undefined;
  return prompt === 0 && completion === 0 ? undefined : { prompt, completion };
}

// Returns the index just past the object opening at `start`, or -1 when the
// text does not contain a complete one. String contents are skipped so a brace
// inside a value cannot end the object early.
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

// Finds the last usable `"usage": { ... }` object in the text. Working from a
// key rather than parsing the whole body means a stream frame, a completion,
// and a fragment left over from an earlier chunk are all handled the same way.
function extractUsage(text: string): TokenUsage | undefined {
  let key = text.lastIndexOf('"usage"');
  while (key >= 0) {
    const open = text.indexOf("{", key);
    if (open >= 0) {
      const end = objectEnd(text, open);
      if (end > 0) {
        try {
          const usage = toUsage(JSON.parse(text.slice(open, end)));
          if (usage !== undefined) return usage;
        } catch {
          // Not a complete object; fall through to an earlier occurrence.
        }
      }
    }
    key = key === 0 ? -1 : text.lastIndexOf('"usage"', key - 1);
  }
  return undefined;
}

// How a body stopped. A provider is answerable for `completed` and `failed`;
// `cancelled` is the client's doing and is evidence of neither.
export type StreamEnd = "completed" | "cancelled" | "failed";

// Passes the body through untouched while watching it for the usage the
// provider reported, so accounting never changes what the client receives.
// Streaming requests only carry usage when the client asks for it, so a stream
// without it is reported as no usage rather than as zero. `onEnd` reports how
// the body ended, which is the first point at which a response is known to
// have been delivered rather than merely started.
export function observeUsage(
  response: Response,
  record: (usage: TokenUsage) => void,
  onEnd?: (end: StreamEnd) => void,
): Response {
  if (response.body === null) {
    onEnd?.("completed");
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let ended = false;

  const finish = (end: StreamEnd) => {
    if (ended) return;
    ended = true;
    const usage = extractUsage(tail);
    if (usage !== undefined) record(usage);
    onEnd?.(end);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        // The provider cut its own stream short. The client has to see that,
        // but everything it sent before the break was still generated - and
        // charged for - so it still counts.
        finish("failed");
        controller.error(error);
        return;
      }
      const { done, value } = result;
      if (done) {
        tail += decoder.decode();
        finish("completed");
        controller.close();
        return;
      }
      tail += decoder.decode(value, { stream: true });
      if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
      controller.enqueue(value);
    },
    cancel(reason) {
      // The client went away, but the provider already generated - and charged
      // for - everything seen so far, so it still counts.
      finish("cancelled");
      void reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
