import type { ProviderConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import { formatSse, mapSseStream } from "../sse.ts";
import type {
  ChatCompletionRequest,
  ChatMessage,
  JsonObject,
  OpenAITool,
  OpenAIToolCall,
} from "../types.ts";
import type { ProviderAdapter } from "./provider.ts";
import { joinUrl, parseProviderError, responseHeaders } from "./provider.ts";

type GeminiProviderConfig = Extract<ProviderConfig, { type: "gemini" }>;

interface GeminiContent extends JsonObject {
  role: "user" | "model";
  parts: JsonObject[];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((raw): string[] => {
      if (raw === null || typeof raw !== "object") return [];
      const part = raw as JsonObject;
      return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // A textual tool result is valid; wrap it below.
  }
  return { result: value };
}

function appendContent(contents: GeminiContent[], content: GeminiContent): void {
  const previous = contents.at(-1);
  if (previous?.role === content.role) previous.parts.push(...content.parts);
  else contents.push(content);
}

function partsForOrdinaryMessage(message: ChatMessage): JsonObject[] {
  const text = textFromContent(message.content);
  return [{ text }];
}

function convertMessages(input: ChatCompletionRequest): {
  systemInstruction?: JsonObject;
  contents: GeminiContent[];
} {
  const system = input.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const toolNames = new Map<string, string>();
  for (const message of input.messages) {
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
  }

  const contents: GeminiContent[] = [];
  for (const message of input.messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "assistant") {
      const parts = partsForOrdinaryMessage(message);
      if (parts[0]?.text === "" && (message.tool_calls?.length ?? 0) > 0) parts.length = 0;
      for (const call of message.tool_calls ?? []) {
        parts.push({
          functionCall: {
            name: call.function.name,
            args: parseJsonObject(call.function.arguments),
          },
        });
      }
      appendContent(contents, { role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      const resultText = textFromContent(message.content);
      appendContent(contents, {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: toolNames.get(message.tool_call_id ?? "") ?? message.name ?? "tool",
              response: parseJsonObject(resultText),
            },
          },
        ],
      });
      continue;
    }
    appendContent(contents, { role: "user", parts: partsForOrdinaryMessage(message) });
  }

  return {
    ...(system === "" ? {} : { systemInstruction: { parts: [{ text: system }] } }),
    contents,
  };
}

function convertTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const declarations = tools.flatMap((raw): JsonObject[] => {
    if (raw === null || typeof raw !== "object") return [];
    const tool = raw as Partial<OpenAITool>;
    if (tool.type !== "function" || tool.function === undefined) return [];
    return [
      {
        name: tool.function.name,
        ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
        parameters: tool.function.parameters ?? { type: "object", properties: {} },
      },
    ];
  });
  return declarations.length === 0 ? undefined : [{ functionDeclarations: declarations }];
}

function convertToolConfig(choice: unknown): JsonObject | undefined {
  if (choice === undefined || choice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice !== null && typeof choice === "object") {
    const object = choice as JsonObject;
    const fn = object.function;
    if (object.type === "function" && fn !== null && typeof fn === "object") {
      const name = (fn as JsonObject).name;
      if (typeof name === "string") {
        return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
      }
    }
  }
  return undefined;
}

function generationConfig(input: ChatCompletionRequest): JsonObject | undefined {
  const config: JsonObject = {};
  const maxTokens =
    typeof input.max_completion_tokens === "number" ? input.max_completion_tokens : input.max_tokens;
  if (typeof maxTokens === "number") config.maxOutputTokens = maxTokens;
  if (typeof input.temperature === "number") config.temperature = input.temperature;
  if (typeof input.top_p === "number") config.topP = input.top_p;
  if (typeof input.stop === "string") config.stopSequences = [input.stop];
  else if (Array.isArray(input.stop)) config.stopSequences = input.stop;
  if (typeof input.presence_penalty === "number") config.presencePenalty = input.presence_penalty;
  if (typeof input.frequency_penalty === "number") config.frequencyPenalty = input.frequency_penalty;

  const format = input.response_format;
  if (format !== null && typeof format === "object") {
    const object = format as JsonObject;
    if (object.type === "json_object" || object.type === "json_schema") {
      config.responseMimeType = "application/json";
    }
    if (object.type === "json_schema" && object.json_schema !== null && typeof object.json_schema === "object") {
      const schema = (object.json_schema as JsonObject).schema;
      if (schema !== undefined) config.responseJsonSchema = schema;
    }
  }
  return Object.keys(config).length === 0 ? undefined : config;
}

function buildGeminiBody(input: ChatCompletionRequest): JsonObject {
  const converted = convertMessages(input);
  const tools = convertTools(input.tools);
  const toolConfig = tools === undefined ? undefined : convertToolConfig(input.tool_choice);
  const config = generationConfig(input);
  return {
    contents: converted.contents,
    ...(converted.systemInstruction === undefined ? {} : { systemInstruction: converted.systemInstruction }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    ...(config === undefined ? {} : { generationConfig: config }),
  };
}

function geminiFinishReason(reason: unknown, hasTools: boolean): string | null {
  if (hasTools && (reason === "STOP" || reason === undefined)) return "tool_calls";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return reason === undefined ? null : "stop";
  }
}

function usageFromGemini(value: JsonObject): JsonObject {
  const usage = value.usageMetadata !== null && typeof value.usageMetadata === "object"
    ? (value.usageMetadata as JsonObject)
    : {};
  const prompt = typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : 0;
  const completion = typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0;
  const total = typeof usage.totalTokenCount === "number" ? usage.totalTokenCount : prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function candidateParts(candidate: JsonObject): JsonObject[] {
  const content = candidate.content;
  if (content === null || typeof content !== "object") return [];
  const parts = (content as JsonObject).parts;
  return Array.isArray(parts)
    ? parts.filter((part): part is JsonObject => part !== null && typeof part === "object")
    : [];
}

function normalizeGeminiJson(value: JsonObject, fallbackModel: string): JsonObject {
  const rawCandidates = Array.isArray(value.candidates) ? value.candidates : [];
  const choices = rawCandidates.flatMap((raw, candidateIndex): JsonObject[] => {
    if (raw === null || typeof raw !== "object") return [];
    const candidate = raw as JsonObject;
    const parts = candidateParts(candidate);
    const text = parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    const toolCalls: OpenAIToolCall[] = parts.flatMap((part, partIndex): OpenAIToolCall[] => {
      const call = part.functionCall;
      if (call === null || typeof call !== "object") return [];
      const object = call as JsonObject;
      if (typeof object.name !== "string") return [];
      return [
        {
          id: `call_${String(value.responseId ?? crypto.randomUUID())}_${candidateIndex}_${partIndex}`,
          type: "function",
          function: { name: object.name, arguments: JSON.stringify(object.args ?? {}) },
        },
      ];
    });
    return [
      {
        index: typeof candidate.index === "number" ? candidate.index : candidateIndex,
        message: {
          role: "assistant",
          content: text === "" && toolCalls.length > 0 ? null : text,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: geminiFinishReason(candidate.finishReason, toolCalls.length > 0),
      },
    ];
  });

  return {
    id: typeof value.responseId === "string" ? value.responseId : `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof value.modelVersion === "string" ? value.modelVersion : fallbackModel,
    choices,
    usage: usageFromGemini(value),
  };
}

function geminiStream(
  source: ReadableStream<Uint8Array>,
  fallbackModel: string,
  includeUsage: boolean,
): ReadableStream<Uint8Array> {
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let model = fallbackModel;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let done = false;
  let toolIndex = 0;

  const chunk = (delta: JsonObject, reason: string | null = null, usage?: JsonObject): Uint8Array =>
    formatSse({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: reason }],
      ...(usage === undefined ? {} : { usage }),
    });

  return mapSseStream(
    source,
    (event) => {
      if (event.data === "[DONE]") {
        done = true;
        return [formatSse("[DONE]")];
      }
      let value: JsonObject;
      try {
        value = JSON.parse(event.data) as JsonObject;
      } catch {
        return [];
      }
      if (value.error !== undefined) {
        done = true;
        const error = value.error as JsonObject;
        return [
          formatSse({
            error: {
              message: typeof error.message === "string" ? error.message : "Gemini stream failed.",
              type: "provider_error",
            },
          }),
          formatSse("[DONE]"),
        ];
      }
      if (typeof value.responseId === "string") id = value.responseId;
      if (typeof value.modelVersion === "string") model = value.modelVersion;
      const output: Uint8Array[] = [];
      if (!sentRole) {
        sentRole = true;
        output.push(chunk({ role: "assistant", content: "" }));
      }
      const candidates = Array.isArray(value.candidates) ? value.candidates : [];
      const candidate = candidates[0];
      if (candidate !== null && typeof candidate === "object") {
        const object = candidate as JsonObject;
        const parts = candidateParts(object);
        let hasTools = false;
        for (const part of parts) {
          if (typeof part.text === "string" && part.text !== "") output.push(chunk({ content: part.text }));
          const rawCall = part.functionCall;
          if (rawCall !== null && typeof rawCall === "object") {
            const call = rawCall as JsonObject;
            if (typeof call.name === "string") {
              hasTools = true;
              output.push(
                chunk({
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: `call_${id}_${toolIndex}`,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                    },
                  ],
                }),
              );
              toolIndex += 1;
            }
          }
        }
        if (object.finishReason !== undefined) {
          output.push(
            chunk(
              {},
              geminiFinishReason(object.finishReason, hasTools),
              includeUsage ? usageFromGemini(value) : undefined,
            ),
          );
        }
      }
      return output;
    },
    () => {
      if (done) return [];
      done = true;
      return [formatSse("[DONE]")];
    },
  );
}

export class GeminiAdapter implements ProviderAdapter {
  readonly type = "gemini" as const;
  readonly timeoutMs: number;

  constructor(
    readonly id: string,
    private readonly config: GeminiProviderConfig,
  ) {
    this.timeoutMs = config.timeout_ms;
  }

  createRequest(input: ChatCompletionRequest, model: string, signal: AbortSignal): Request {
    const modelName = model.replace(/^models\//, "");
    const method = input.stream === true ? "streamGenerateContent?alt=sse" : "generateContent";
    const headers = new Headers(this.config.headers);
    headers.set("content-type", "application/json");
    if (this.config.api_key !== undefined) headers.set("x-goog-api-key", this.config.api_key);
    return new Request(joinUrl(this.config.base_url, `models/${encodeURIComponent(modelName)}:${method}`), {
      method: "POST",
      headers,
      body: JSON.stringify(buildGeminiBody(input)),
      signal,
    });
  }

  async normalizeResponse(
    response: Response,
    input: ChatCompletionRequest,
    model: string,
  ): Promise<Response> {
    if (input.stream === true) {
      if (response.body === null) {
        throw new GatewayError({
          message: `Provider '${this.id}' returned an empty stream.`,
          status: 502,
          type: "provider_error",
        });
      }
      const streamOptions = input.stream_options as JsonObject | undefined;
      return new Response(geminiStream(response.body, model, streamOptions?.include_usage === true), {
        headers: responseHeaders("text/event-stream; charset=utf-8", response.headers),
      });
    }
    const body = (await response.json()) as JsonObject;
    return Response.json(normalizeGeminiJson(body, model), {
      headers: responseHeaders("application/json", response.headers),
    });
  }

  parseError(response: Response) {
    return parseProviderError(response, this.id);
  }
}
