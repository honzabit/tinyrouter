import type { ProviderConfig } from "../config.ts";
import type { ChatCompletionRequest } from "../types.ts";
import type { ProviderAdapter } from "./provider.ts";
import { joinUrl, parseProviderError, responseHeaders } from "./provider.ts";

type OpenAIProviderConfig = Extract<ProviderConfig, { type: "openai" | "openai-compatible" }>;

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type: OpenAIProviderConfig["type"];
  readonly timeoutMs: number;

  constructor(
    readonly id: string,
    private readonly config: OpenAIProviderConfig,
  ) {
    this.type = config.type;
    this.timeoutMs = config.timeout_ms;
  }

  createRequest(input: ChatCompletionRequest, model: string, signal: AbortSignal): Request {
    const headers = new Headers(this.config.headers);
    headers.set("content-type", "application/json");
    if (this.config.api_key !== undefined) headers.set("authorization", `Bearer ${this.config.api_key}`);

    return new Request(joinUrl(this.config.base_url, "chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, model }),
      signal,
    });
  }

  async normalizeResponse(
    response: Response,
    input: ChatCompletionRequest,
    _model: string,
  ): Promise<Response> {
    const contentType = input.stream === true ? "text/event-stream; charset=utf-8" : "application/json";
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders(contentType, response.headers),
    });
  }

  parseError(response: Response) {
    return parseProviderError(response, this.id);
  }
}
