import type { ProviderConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import type { ChatCompletionRequest } from "../types.ts";

export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderConfig["type"];
  readonly timeoutMs: number;
  createRequest(input: ChatCompletionRequest, model: string, signal: AbortSignal): Request;
  normalizeResponse(
    response: Response,
    input: ChatCompletionRequest,
    model: string,
  ): Promise<Response>;
  parseError(response: Response): Promise<GatewayError>;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function findErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.message === "string") return object.message;
  if (object.error !== undefined) return findErrorMessage(object.error);
  return undefined;
}

export async function parseProviderError(
  response: Response,
  providerId: string,
): Promise<GatewayError> {
  let body: unknown;
  try {
    const text = await response.text();
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  } catch {
    body = undefined;
  }

  const upstreamMessage = findErrorMessage(body);
  const status = response.status;
  if (status === 401 || status === 403) {
    return new GatewayError({
      message: `Provider '${providerId}' rejected its configured credentials.`,
      status: 502,
      type: "provider_authentication_error",
      code: String(status),
      details: body,
    });
  }
  if (status === 429) {
    return new GatewayError({
      message: upstreamMessage ?? `Provider '${providerId}' is rate limited.`,
      status: 429,
      type: "provider_rate_limit_error",
      code: "429",
      retryable: true,
      details: body,
    });
  }
  if (status >= 400 && status < 500) {
    return new GatewayError({
      message: upstreamMessage ?? `Provider '${providerId}' rejected the request.`,
      status,
      type: "invalid_request_error",
      code: String(status),
      details: body,
    });
  }
  return new GatewayError({
    message: upstreamMessage ?? `Provider '${providerId}' failed with HTTP ${status}.`,
    status: status === 503 ? 503 : 502,
    type: status === 503 ? "service_unavailable" : "provider_error",
    code: String(status),
    retryable: status >= 500,
    details: body,
  });
}

export function responseHeaders(contentType: string, source?: Headers): Headers {
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const requestId = source?.get("x-request-id");
  if (requestId !== null && requestId !== undefined) headers.set("x-upstream-request-id", requestId);
  return headers;
}
