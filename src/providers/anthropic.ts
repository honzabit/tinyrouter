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

type AnthropicProviderConfig = Extract<ProviderConfig, { type: "anthropic" }>;

interface AnthropicBlock extends JsonObject {
  type: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

const usageSchema = z.looseObject({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
});

const responseSchema = z.looseObject({
  id: z.string().nullish(),
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  content: z
    .array(
      z.looseObject({
        type: z.string().nullish(),
        text: z.string().nullish(),
        id: z.string().nullish(),
        name: z.string().nullish(),
        input: z.unknown().optional(),
      }),
    )
    .nullish(),
  usage: usageSchema.nullish(),
});

const streamEventSchema = z.looseObject({
  type: z.string().nullish(),
  index: z.number().nullish(),
  message: z
    .looseObject({
      id: z.string().nullish(),
      model: z.string().nullish(),
      usage: usageSchema.nullish(),
    })
    .nullish(),
  content_block: z
    .looseObject({
      type: z.string().nullish(),
      id: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
  delta: z
    .looseObject({
      type: z.string().nullish(),
      text: z.string().nullish(),
      partial_json: z.string().nullish(),
      stop_reason: z.string().nullish(),
    })
    .nullish(),
  usage: usageSchema.nullish(),
  error: z.looseObject({ message: z.string().nullish() }).nullish(),
});

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        part !== null &&
        typeof part === "object" &&
        (part as JsonObject).type === "text" &&
        typeof (part as JsonObject).text === "string"
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function parseToolArguments(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function imageBlock(part: JsonObject): AnthropicBlock {
  const url =
    part.image_url !== null && typeof part.image_url === "object"
      ? (part.image_url as JsonObject).url
      : undefined;
  if (typeof url !== "string") {
    throw unsupportedContent("Image content parts must contain an image_url object with a string url.");
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  const dataUrl = parseDataUrl(url);
  if (dataUrl !== undefined) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl.mediaType, data: dataUrl.data },
    };
  }
  throw unsupportedContent("Image URLs must be http(s) URLs or base64-encoded data: URIs.");
}

function userBlocks(message: ChatMessage): AnthropicBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  if (!Array.isArray(message.content)) return [{ type: "text", text: "" }];

  const blocks: AnthropicBlock[] = [];
  for (const raw of message.content) {
    if (raw === null || typeof raw !== "object") {
      throw unsupportedContent("Message content parts must be objects.");
    }
    const part = raw as JsonObject;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      blocks.push(imageBlock(part));
      continue;
    }
    throw unsupportedContent(
      `Content part type '${typeof part.type === "string" ? part.type : "unknown"}' is not supported for Anthropic providers.`,
    );
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function assistantBlocks(message: ChatMessage): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  const text = textFromContent(message.content);
  if (text !== "") blocks.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function appendMessage(messages: AnthropicMessage[], message: AnthropicMessage): void {
  const previous = messages.at(-1);
  if (previous?.role === message.role) previous.content.push(...message.content);
  else messages.push(message);
}

function convertMessages(input: ChatCompletionRequest): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const system = input.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");

  const messages: AnthropicMessage[] = [];
  for (const message of input.messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "assistant") {
      appendMessage(messages, { role: "assistant", content: assistantBlocks(message) });
      continue;
    }
    if (message.role === "tool") {
      appendMessage(messages, {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "unknown",
            content: textFromContent(message.content),
          },
        ],
      });
      continue;
    }
    appendMessage(messages, { role: "user", content: userBlocks(message) });
  }

  return { ...(system === "" ? {} : { system }), messages };
}

function convertTools(tools: ChatCompletionRequest["tools"]): JsonObject[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    input_schema: tool.function.parameters ?? { type: "object", properties: {} },
  }));
}

function convertToolChoice(choice: unknown): JsonObject | undefined {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (choice !== null && typeof choice === "object") {
    const object = choice as JsonObject;
    const fn = object.function;
    if (object.type === "function" && fn !== null && typeof fn === "object") {
      const name = (fn as JsonObject).name;
      if (typeof name === "string") return { type: "tool", name };
    }
  }
  return undefined;
}

function buildAnthropicBody(
  input: ChatCompletionRequest,
  model: string,
  defaultMaxTokens: number,
): JsonObject {
  const converted = convertMessages(input);
  const tools = convertTools(input.tools);
  let toolChoice = tools === undefined ? undefined : convertToolChoice(input.tool_choice);
  if (tools !== undefined && input.parallel_tool_calls === false && toolChoice?.type !== "none") {
    toolChoice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  const maxTokens =
    typeof input.max_completion_tokens === "number"
      ? input.max_completion_tokens
      : typeof input.max_tokens === "number"
        ? input.max_tokens
        : defaultMaxTokens;

  return {
    model,
    messages: converted.messages,
    ...(converted.system === undefined ? {} : { system: converted.system }),
    max_tokens: maxTokens,
    ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
    ...(typeof input.top_p === "number" ? { top_p: input.top_p } : {}),
    ...(typeof input.stop === "string"
      ? { stop_sequences: [input.stop] }
      : Array.isArray(input.stop)
        ? { stop_sequences: input.stop }
        : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    stream: input.stream === true,
  };
}

function finishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return null;
  }
}

function normalizeAnthropicJson(providerId: string, value: unknown, fallbackModel: string): JsonObject {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayError({
      message: `Provider '${providerId}' returned an unexpected response body.`,
      status: 502,
      type: "provider_error",
      retryable: true,
    });
  }
  const blocks = parsed.data.content ?? [];
  const text = blocks
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("");
  const toolCalls: OpenAIToolCall[] = blocks.flatMap((block): OpenAIToolCall[] => {
    if (block.type !== "tool_use" || typeof block.name !== "string") return [];
    return [
      {
        id: block.id ?? crypto.randomUUID(),
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      },
    ];
  });
  const promptTokens = parsed.data.usage?.input_tokens ?? 0;
  const completionTokens = parsed.data.usage?.output_tokens ?? 0;

  return {
    id: parsed.data.id ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: parsed.data.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text === "" && toolCalls.length > 0 ? null : text,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: finishReason(parsed.data.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function anthropicStream(
  source: ReadableStream<Uint8Array>,
  fallbackModel: string,
  includeUsage: boolean,
): ReadableStream<Uint8Array> {
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let model = fallbackModel;
  const created = Math.floor(Date.now() / 1000);
  let promptTokens = 0;
  let completionTokens = 0;
  let done = false;
  let nextToolIndex = 0;
  const toolIndexes = new Map<number, number>();

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
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        }),
      );
    }
    output.push(formatSse("[DONE]"));
    return output;
  };

  return mapSseStream(
    source,
    (event) => {
      if (event.data === "[DONE]") return [];
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return [];
      }
      const parsed = streamEventSchema.safeParse(raw);
      if (!parsed.success) return [];
      const value = parsed.data;
      const type = value.type ?? event.event;
      if (type === "message_start") {
        id = value.message?.id ?? id;
        model = value.message?.model ?? model;
        promptTokens = value.message?.usage?.input_tokens ?? promptTokens;
        return [chunk({ role: "assistant", content: "" })];
      }
      if (type === "content_block_start") {
        const block = value.content_block;
        if (block?.type !== "tool_use" || block.name == null) return [];
        const toolIndex = nextToolIndex++;
        toolIndexes.set(value.index ?? 0, toolIndex);
        return [
          chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id ?? crypto.randomUUID(),
                type: "function",
                function: { name: block.name, arguments: "" },
              },
            ],
          }),
        ];
      }
      if (type === "content_block_delta") {
        const delta = value.delta;
        if (delta?.type === "text_delta" && delta.text != null) {
          return [chunk({ content: delta.text })];
        }
        if (delta?.type === "input_json_delta" && delta.partial_json != null) {
          const toolIndex = toolIndexes.get(value.index ?? 0) ?? 0;
          return [chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] })];
        }
        return [];
      }
      if (type === "message_delta") {
        completionTokens = value.usage?.output_tokens ?? completionTokens;
        return [chunk({}, finishReason(value.delta?.stop_reason))];
      }
      if (type === "error") {
        done = true;
        return [
          formatSse({
            error: {
              message: value.error?.message ?? "Anthropic stream failed.",
              type: "provider_error",
            },
          }),
          formatSse("[DONE]"),
        ];
      }
      if (type === "message_stop") {
        done = true;
        return finalChunks();
      }
      return [];
    },
    () => (done ? [] : finalChunks()),
  );
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly type = "anthropic" as const;
  readonly timeoutMs: number;

  constructor(
    readonly id: string,
    private readonly config: AnthropicProviderConfig,
  ) {
    this.timeoutMs = config.timeout_ms;
  }

  createRequest(input: ChatCompletionRequest, model: string, signal: AbortSignal): Request {
    const headers = new Headers(this.config.headers);
    headers.set("content-type", "application/json");
    headers.set("anthropic-version", this.config.anthropic_version);
    if (this.config.api_key !== undefined) headers.set("x-api-key", this.config.api_key);
    return new Request(joinUrl(this.config.base_url, "messages"), {
      method: "POST",
      headers,
      body: JSON.stringify(buildAnthropicBody(input, model, this.config.default_max_tokens)),
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
      return new Response(
        anthropicStream(response.body, model, input.stream_options?.include_usage === true),
        { headers: responseHeaders("text/event-stream; charset=utf-8", response.headers) },
      );
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
    return Response.json(normalizeAnthropicJson(this.id, body, model), {
      headers: responseHeaders("application/json", response.headers),
    });
  }

  parseError(response: Response) {
    return parseProviderError(response, this.id);
  }
}
