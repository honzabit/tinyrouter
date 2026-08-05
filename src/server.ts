import { timingSafeEqual } from "node:crypto";
import type { TinyRouterConfig } from "./config.ts";
import { clientClosedRequest, errorResponse, GatewayError, unknownErrorResponse } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { jsonLogger } from "./logger.ts";
import { Metrics } from "./metrics.ts";
import { createAdapters } from "./providers/index.ts";
import { type Fetch, Router } from "./router.ts";
import { chatRequestSchema } from "./types.ts";
import { VERSION } from "./version.ts";

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
  return supplied !== null && supplied.length > 0 && supplied.length <= 128 ? supplied : crypto.randomUUID();
}

function bodyTooLarge(maxBytes: number): GatewayError {
  return new GatewayError({
    message: `Request body exceeds the ${maxBytes}-byte limit.`,
    status: 413,
    type: "invalid_request_error",
    code: "body_too_large",
  });
}

async function readBody(request: Request, maxBytes: number, idleMs: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw bodyTooLarge(maxBytes);
  }

  // Enforce the limit while reading so a chunked body cannot buffer unbounded.
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    // One listener for the whole body rather than one per chunk.
    const disconnected = new Promise<"disconnected">((resolve) => {
      if (request.signal.aborted) resolve("disconnected");
      else request.signal.addEventListener("abort", () => resolve("disconnected"), { once: true });
    });
    try {
      while (true) {
        // Bound the gap between chunks, not the whole upload: a slow client
        // keeps its request, a silent one does not keep the handler.
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<"idle">((resolve) => {
          idleTimer = setTimeout(() => resolve("idle"), idleMs);
        });
        const result = await Promise.race([reader.read(), disconnected, idle]);
        clearTimeout(idleTimer);

        if (result === "disconnected") {
          await reader.cancel(new Error("The client closed the request.")).catch(() => {});
          throw clientClosedRequest();
        }
        if (result === "idle") {
          await reader.cancel(new Error("Request body stalled.")).catch(() => {});
          throw new GatewayError({
            message: `The request body stopped arriving for ${idleMs}ms.`,
            status: 408,
            type: "invalid_request_error",
            code: "body_timeout",
          });
        }
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel(new Error("Request body too large."));
          throw bodyTooLarge(maxBytes);
        }
        chunks.push(result.value);
      }
    } catch (error) {
      // A peer that vanishes mid-upload surfaces as a stream error. The
      // gateway did nothing wrong, so it reports a closed request rather than
      // a fault of its own.
      if (error instanceof GatewayError) throw error;
      throw clientClosedRequest(error);
    } finally {
      reader.releaseLock();
    }
  }

  const text = Buffer.concat(chunks).toString("utf8");
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
      return Response.json({ name: "TinyRouter", version: VERSION, status: "ok" });
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
      const raw = await readBody(request, config.server.max_body_bytes, config.server.body_timeout_ms);
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
      const input = parsed.data;
      metricModel = input.model;
      const result = await router.route(input, request.signal);
      metricProvider = result.target.providerId;
      metricModel = result.target.model;
      metricStatus = String(result.response.status);
      result.response.headers.set("x-request-id", id);
      result.response.headers.set("x-tinyrouter-provider", result.target.providerId);
      result.response.headers.set("x-tinyrouter-model", result.target.model);
      if (result.redactions > 0)
        result.response.headers.set("x-tinyrouter-redactions", String(result.redactions));
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
        ...(result.redactions > 0 ? { redactions: result.redactions } : {}),
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
          attempts: error.attempts,
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
