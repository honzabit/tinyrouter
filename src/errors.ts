import type { JsonValue } from "type-fest";
import type { AttemptRecord } from "./types.ts";

export type ErrorType =
  | "api_error"
  | "authentication_error"
  | "client_closed_request"
  | "invalid_request_error"
  | "model_not_found"
  | "provider_authentication_error"
  | "provider_rate_limit_error"
  | "provider_timeout_error"
  | "provider_error"
  | "service_unavailable";

export class GatewayError extends Error {
  readonly status: number;
  readonly type: ErrorType;
  readonly code?: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
  readonly attempts?: AttemptRecord[];

  constructor(options: {
    message: string;
    status: number;
    type: ErrorType;
    code?: string;
    retryable?: boolean;
    details?: JsonValue;
    attempts?: AttemptRecord[];
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    this.status = options.status;
    this.type = options.type;
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
    if (options.attempts !== undefined) this.attempts = options.attempts;
  }
}

export function errorResponse(error: GatewayError, requestId?: string): Response {
  const body = {
    error: {
      message: error.message,
      type: error.type,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(requestId === undefined ? {} : { request_id: requestId }),
    },
  };

  return Response.json(body, {
    status: error.status,
    headers: {
      "cache-control": "no-store",
      ...(requestId === undefined ? {} : { "x-request-id": requestId }),
    },
  });
}

export function unknownErrorResponse(requestId: string): Response {
  return errorResponse(
    new GatewayError({
      message: "An unexpected gateway error occurred.",
      status: 500,
      type: "api_error",
    }),
    requestId,
  );
}
