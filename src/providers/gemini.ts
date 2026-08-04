import type { JsonValue } from "type-fest";
import { z } from "zod";
import type { ProviderConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import { formatSse, mapSseStream } from "../sse.ts";
import type { ChatCompletionRequest, ChatMessage, JsonObject, OpenAIToolCall } from "../types.ts";
import type { ProviderAdapter } from "./provider.ts";
import {
  joinUrl,
  parseDataUrl,
  parseProviderError,
  responseHeaders,
  unsupportedContent,
} from "./provider.ts";

type GeminiProviderConfig = Extract<ProviderConfig, { type: "gemini" }>;

interface GeminiContent extends JsonObject {
  role: "user" | "model";
  parts: JsonObject[];
}

const usageMetadataSchema = z.looseObject({
  promptTokenCount: z.number().nullish(),
  candidatesTokenCount: z.number().nullish(),
  totalTokenCount: z.number().nullish(),
});

const partSchema = z.looseObject({
  text: z.string().nullish(),
  functionCall: z
    .looseObject({
      name: z.string().nullish(),
      args: z.unknown().optional(),
    })
    .nullish(),
});

const candidateSchema = z.looseObject({
  index: z.number().nullish(),
  content: z.looseObject({ parts: z.array(partSchema).nullish() }).nullish(),
  finishReason: z.string().nullish(),
});

const responseSchema = z.looseObject({
  responseId: z.string().nullish(),
  modelVersion: z.string().nullish(),
  candidates: z.array(candidateSchema).nullish(),
  usageMetadata: usageMetadataSchema.nullish(),
  error: z.looseObject({ message: z.string().nullish() }).nullish(),
});

type GeminiUsage = z.infer<typeof usageMetadataSchema>;

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

function partsForUserMessage(message: ChatMessage): JsonObject[] {
  if (typeof message.content === "string") return [{ text: message.content }];
  if (!Array.isArray(message.content)) return [{ text: "" }];

  const parts: JsonObject[] = [];
  for (const raw of message.content) {
    if (raw === null || typeof raw !== "object") {
      throw unsupportedContent("Message content parts must be objects.");
    }
    const part = raw as JsonObject;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const url =
        part.image_url !== null && typeof part.image_url === "object"
          ? (part.image_url as JsonObject).url
          : undefined;
      if (typeof url !== "string") {
        throw unsupportedContent("Image content parts must contain an image_url object with a string url.");
      }
      const dataUrl = parseDataUrl(url);
      if (dataUrl === undefined) {
        throw unsupportedContent(
          "Gemini providers accept images as base64-encoded data: URIs only; fetch the image and inline it.",
        );
      }
      parts.push({ inlineData: { mimeType: dataUrl.mediaType, data: dataUrl.data } });
      continue;
    }
    throw unsupportedContent(
      `Content part type '${typeof part.type === "string" ? part.type : "unknown"}' is not supported for Gemini providers.`,
    );
  }
  return parts.length > 0 ? parts : [{ text: "" }];
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
      const text = textFromContent(message.content);
      const parts: JsonObject[] = text === "" && (message.tool_calls?.length ?? 0) > 0 ? [] : [{ text }];
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
    appendContent(contents, { role: "user", parts: partsForUserMessage(message) });
  }

  return {
    ...(system === "" ? {} : { systemInstruction: { parts: [{ text: system }] } }),
    contents,
  };
}

function convertTools(tools: ChatCompletionRequest["tools"]): JsonObject[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const declarations = tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  }));
  return [{ functionDeclarations: declarations }];
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
    if (
      object.type === "json_schema" &&
      object.json_schema !== null &&
      typeof object.json_schema === "object"
    ) {
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

function geminiFinishReason(reason: string | null | undefined, hasTools: boolean): string | null {
  if (hasTools && (reason === "STOP" || reason == null)) return "tool_calls";
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
      return reason == null ? null : "stop";
  }
}

function usageFromGemini(usage: GeminiUsage | null | undefined): JsonObject {
  const prompt = usage?.promptTokenCount ?? 0;
  const completion = usage?.candidatesTokenCount ?? 0;
  const total = usage?.totalTokenCount ?? prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function normalizeGeminiJson(providerId: string, value: unknown, fallbackModel: string): JsonObject {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayError({
      message: `Provider '${providerId}' returned an unexpected response body.`,
      status: 502,
      type: "provider_error",
      retryable: true,
    });
  }
  const responseId = parsed.data.responseId;
  const choices = (parsed.data.candidates ?? []).map((candidate, candidateIndex) => {
    const parts = candidate.content?.parts ?? [];
    const text = parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("");
    const toolCalls: OpenAIToolCall[] = parts.flatMap((part, partIndex): OpenAIToolCall[] => {
      const call = part.functionCall;
      if (call?.name == null) return [];
      return [
        {
          id: `call_${responseId ?? crypto.randomUUID()}_${candidateIndex}_${partIndex}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        },
      ];
    });
    return {
      index: candidate.index ?? candidateIndex,
      message: {
        role: "assistant",
        content: text === "" && toolCalls.length > 0 ? null : text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      },
      finish_reason: geminiFinishReason(candidate.finishReason, toolCalls.length > 0),
    };
  });

  return {
    id: responseId ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: parsed.data.modelVersion ?? fallbackModel,
    choices,
    usage: usageFromGemini(parsed.data.usageMetadata),
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
  let usage: JsonObject | undefined;

  const chunk = (delta: { [key: string]: JsonValue }, reason: string | null = null): Uint8Array =>
    formatSse({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: reason }],
    });

  // OpenAI convention: with include_usage, usage arrives in a dedicated final
  // chunk whose choices array is empty, immediately before [DONE].
  const finalChunks = (): Uint8Array[] => {
    const output: Uint8Array[] = [];
    if (includeUsage) {
      output.push(
        formatSse({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: (usage ?? usageFromGemini(undefined)) as JsonValue,
        }),
      );
    }
    output.push(formatSse("[DONE]"));
    return output;
  };

  return mapSseStream(
    source,
    (event) => {
      if (event.data === "[DONE]") {
        done = true;
        return finalChunks();
      }
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return [];
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) return [];
      const value = parsed.data;
      if (value.error != null) {
        done = true;
        return [
          formatSse({
            error: {
              message: value.error.message ?? "Gemini stream failed.",
              type: "provider_error",
            },
          }),
          formatSse("[DONE]"),
        ];
      }
      id = value.responseId ?? id;
      model = value.modelVersion ?? model;
      if (value.usageMetadata != null) usage = usageFromGemini(value.usageMetadata);
      const output: Uint8Array[] = [];
      if (!sentRole) {
        sentRole = true;
        output.push(chunk({ role: "assistant", content: "" }));
      }
      const candidate = (value.candidates ?? [])[0];
      if (candidate !== undefined) {
        let hasTools = false;
        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text === "string" && part.text !== "") output.push(chunk({ content: part.text }));
          const call = part.functionCall;
          if (call?.name != null) {
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
        if (candidate.finishReason != null) {
          output.push(chunk({}, geminiFinishReason(candidate.finishReason, hasTools)));
        }
      }
      return output;
    },
    () => {
      if (done) return [];
      done = true;
      return finalChunks();
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
          retryable: true,
        });
      }
      return new Response(geminiStream(response.body, model, input.stream_options?.include_usage === true), {
        headers: responseHeaders("text/event-stream; charset=utf-8", response.headers),
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new GatewayError({
        message: `Provider '${this.id}' returned a response that is not valid JSON.`,
        status: 502,
        type: "provider_error",
        retryable: true,
        cause: error,
      });
    }
    return Response.json(normalizeGeminiJson(this.id, body, model), {
      headers: responseHeaders("application/json", response.headers),
    });
  }

  parseError(response: Response) {
    return parseProviderError(response, this.id);
  }
}
