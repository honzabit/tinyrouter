import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TinyRouterConfig } from "./config.ts";
import { errorResponse, GatewayError, unknownErrorResponse } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { jsonLogger } from "./logger.ts";
import { Metrics } from "./metrics.ts";
import { createAdapters } from "./providers/index.ts";
import { Router, type Fetch } from "./router.ts";
import type { AttemptRecord, ChatCompletionRequest } from "./types.ts";

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const messageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.unknown().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  })
  .passthrough();

const chatRequestSchema = z
  .object({
    model: z.string().min(1).max(512),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    tools: z.array(toolSchema).optional(),
  })
  .passthrough();

function authorized(request: Request, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  return supplied !== null && supplied.length > 0 && supplied.length <= 128
    ? supplied
    : crypto.randomUUID();
}

function detailsAttempts(error: GatewayError): AttemptRecord[] | undefined {
  if (error.details === null || typeof error.details !== "object") return undefined;
  const attempts = (error.details as Record<string, unknown>).attempts;
  return Array.isArray(attempts) ? (attempts as AttemptRecord[]) : undefined;
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new GatewayError({
      message: `Request body exceeds the ${maxBytes}-byte limit.`,
      status: 413,
      type: "invalid_request_error",
      code: "body_too_large",
    });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new GatewayError({
      message: `Request body exceeds the ${maxBytes}-byte limit.`,
      status: 413,
      type: "invalid_request_error",
      code: "body_too_large",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GatewayError({
      message: "Request body must be valid JSON.",
      status: 400,
      type: "invalid_request_error",
      code: "invalid_json",
      cause: error,
    });
  }
}

export interface Gateway {
  fetch(request: Request): Promise<Response>;
  metrics: Metrics;
  router: Router;
}

export function createGateway(
  config: TinyRouterConfig,
  options: { fetch?: Fetch; logger?: Logger } = {},
): Gateway {
  const metrics = new Metrics();
  const logger = options.logger ?? jsonLogger;
  const router = new Router(config, createAdapters(config), metrics, options.fetch ?? fetch);

  async function handle(request: Request): Promise<Response> {
    const id = requestId(request);
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (url.pathname === "/readyz") {
      return Response.json({ status: "ready", providers: Object.keys(config.providers).length });
    }
    if (url.pathname === "/metrics") {
      return new Response(metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname === "/") {
      return Response.json({ name: "TinyRouter", version: "0.1.0", status: "ok" });
    }

    if (url.pathname.startsWith("/v1/") && !authorized(request, config.server.api_key)) {
      return errorResponse(
        new GatewayError({
          message: "Invalid or missing API key.",
          status: 401,
          type: "authentication_error",
          code: "invalid_api_key",
        }),
        id,
      );
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return Response.json(
        {
          object: "list",
          data: router.listModels().map((model) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: "tinyrouter",
            tinyrouter: { kind: model.kind, targets: model.targets },
          })),
        },
        { headers: { "cache-control": "no-store", "x-request-id": id } },
      );
    }

    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return errorResponse(
        new GatewayError({
          message: "Endpoint not found.",
          status: 404,
          type: "invalid_request_error",
          code: "not_found",
        }),
        id,
      );
    }

    metrics.requestStarted();
    const startedAt = performance.now();
    let metricProvider = "none";
    let metricModel = "unknown";
    let metricStatus = "500";
    try {
      const raw = await readBody(request, config.server.max_body_bytes);
      const parsed = chatRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw new GatewayError({
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
            .join("; "),
          status: 400,
          type: "invalid_request_error",
          code: "invalid_request",
        });
      }
      const input = parsed.data as ChatCompletionRequest;
      metricModel = input.model;
      const result = await router.route(input, request.signal);
      metricProvider = result.target.providerId;
      metricModel = result.target.model;
      metricStatus = String(result.response.status);
      result.response.headers.set("x-request-id", id);
      result.response.headers.set("x-tinyrouter-provider", result.target.providerId);
      result.response.headers.set("x-tinyrouter-model", result.target.model);
      logger.log({
        level: "info",
        event: "request_completed",
        request_id: id,
        requested_model: input.model,
        provider: result.target.providerId,
        model: result.target.model,
        status: result.response.status,
        stream: input.stream === true,
        duration_ms: Math.round(performance.now() - startedAt),
        attempts: result.attempts,
      });
      return result.response;
    } catch (error) {
      if (error instanceof GatewayError) {
        metricStatus = String(error.status);
        logger.log({
          level: error.status >= 500 ? "error" : "warn",
          event: "request_failed",
          request_id: id,
          model: metricModel,
          status: error.status,
          error_type: error.type,
          duration_ms: Math.round(performance.now() - startedAt),
          attempts: detailsAttempts(error),
        });
        return errorResponse(error, id);
      }
      logger.log({
        level: "error",
        event: "request_failed",
        request_id: id,
        model: metricModel,
        status: 500,
        error_type: "unexpected_error",
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return unknownErrorResponse(id);
    } finally {
      metrics.requestFinished({ provider: metricProvider, model: metricModel, status: metricStatus });
    }
  }

  return { fetch: handle, metrics, router };
}
