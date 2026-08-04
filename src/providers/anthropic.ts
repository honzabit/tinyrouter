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

type AnthropicProviderConfig = Extract<ProviderConfig, { type: "anthropic" }>;

interface AnthropicBlock extends JsonObject {
  type: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

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

function userBlocks(message: ChatMessage): AnthropicBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  if (!Array.isArray(message.content)) return [{ type: "text", text: "" }];

  const blocks: AnthropicBlock[] = [];
  for (const raw of message.content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as JsonObject;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" && part.image_url !== null && typeof part.image_url === "object") {
      const url = (part.image_url as JsonObject).url;
      if (typeof url === "string" && /^https?:\/\//.test(url)) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
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

function convertTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools.flatMap((raw): JsonObject[] => {
    if (raw === null || typeof raw !== "object") return [];
    const tool = raw as Partial<OpenAITool>;
    if (tool.type !== "function" || tool.function === undefined) return [];
    return [
      {
        name: tool.function.name,
        ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
        input_schema: tool.function.parameters ?? { type: "object", properties: {} },
      },
    ];
  });
  return converted.length === 0 ? undefined : converted;
}

function convertToolChoice(choice: unknown): JsonObject | undefined {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none" || choice === undefined) return undefined;
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
  const toolChoice = convertToolChoice(input.tool_choice);
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

function finishReason(reason: unknown): string | null {
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

function normalizeAnthropicJson(value: JsonObject, fallbackModel: string): JsonObject {
  const blocks = Array.isArray(value.content) ? value.content : [];
  const text = blocks
    .filter((block): block is JsonObject => block !== null && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const toolCalls: OpenAIToolCall[] = blocks
    .filter((block): block is JsonObject => block !== null && typeof block === "object")
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
      type: "function",
      function: {
        name: block.name as string,
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
  const usage = value.usage !== null && typeof value.usage === "object" ? (value.usage as JsonObject) : {};
  const promptTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const completionTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  return {
    id: typeof value.id === "string" ? value.id : `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text === "" && toolCalls.length > 0 ? null : text,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: finishReason(value.stop_reason),
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
      if (event.data === "[DONE]") return [];
      let value: JsonObject;
      try {
        value = JSON.parse(event.data) as JsonObject;
      } catch {
        return [];
      }
      const type = typeof value.type === "string" ? value.type : event.event;
      if (type === "message_start") {
        const message = value.message as JsonObject | undefined;
        if (typeof message?.id === "string") id = message.id;
        if (typeof message?.model === "string") model = message.model;
        const usage = message?.usage as JsonObject | undefined;
        if (typeof usage?.input_tokens === "number") promptTokens = usage.input_tokens;
        return [chunk({ role: "assistant", content: "" })];
      }
      if (type === "content_block_start") {
        const index = typeof value.index === "number" ? value.index : 0;
        const block = value.content_block as JsonObject | undefined;
        if (block?.type !== "tool_use" || typeof block.name !== "string") return [];
        const toolIndex = nextToolIndex++;
        toolIndexes.set(index, toolIndex);
        return [
          chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
                type: "function",
                function: { name: block.name, arguments: "" },
              },
            ],
          }),
        ];
      }
      if (type === "content_block_delta") {
        const delta = value.delta as JsonObject | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return [chunk({ content: delta.text })];
        }
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const blockIndex = typeof value.index === "number" ? value.index : 0;
          const toolIndex = toolIndexes.get(blockIndex) ?? 0;
          return [chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] })];
        }
        return [];
      }
      if (type === "message_delta") {
        const delta = value.delta as JsonObject | undefined;
        const usage = value.usage as JsonObject | undefined;
        if (typeof usage?.output_tokens === "number") completionTokens = usage.output_tokens;
        const normalizedUsage = includeUsage
          ? {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            }
          : undefined;
        return [chunk({}, finishReason(delta?.stop_reason), normalizedUsage)];
      }
      if (type === "error") {
        const error = value.error as JsonObject | undefined;
        done = true;
        return [
          formatSse({
            error: {
              message: typeof error?.message === "string" ? error.message : "Anthropic stream failed.",
              type: "provider_error",
            },
          }),
          formatSse("[DONE]"),
        ];
      }
      if (type === "message_stop") {
        done = true;
        return [formatSse("[DONE]")];
      }
      return [];
    },
    () => (done ? [] : [formatSse("[DONE]")]),
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
        });
      }
      const streamOptions = input.stream_options as JsonObject | undefined;
      return new Response(
        anthropicStream(response.body, model, streamOptions?.include_usage === true),
        { headers: responseHeaders("text/event-stream; charset=utf-8", response.headers) },
      );
    }
    const body = (await response.json()) as JsonObject;
    return Response.json(normalizeAnthropicJson(body, model), {
      headers: responseHeaders("application/json", response.headers),
    });
  }

  parseError(response: Response) {
    return parseProviderError(response, this.id);
  }
}
