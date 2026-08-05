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

// The only endpoints ever shared with a browser. api_key is optional, so a
// gateway may be running open on localhost; if a page could reach completions
// cross-origin it could spend the operator's provider credits, and the
// preflight it cannot pass is what prevents that.
const SHARED_PATHS = new Set(["/", "/healthz", "/readyz", "/metrics", "/v1/models"]);

function corsHeaders(request: Request, allowed: readonly string[] | undefined): Record<string, string> {
  if (allowed === undefined) return {};
  const origin = request.headers.get("origin");
  // Vary whichever way it goes: the response depends on Origin, so a cache
  // must never hand one origin's copy to another.
  if (origin === null || !allowed.includes(origin)) return { vary: "Origin" };
  // Echo the exact origin that asked, never a wildcard, and never
  // Allow-Credentials: the key travels in a header, not ambiently. Without
  // Expose-Headers a page can read only the safelisted few, so the request id
  // that ties a click to a log line would be sent and then withheld.
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "x-request-id",
    vary: "Origin",
  };
}

function withCors(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) {
    // Vary is a list. Replacing it would drop whatever else a response already
    // varies on, and a shared cache would then serve one variant for all of it.
    if (name === "vary") response.headers.append(name, value);
    else response.headers.set(name, value);
  }
  return response;
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
    // Stopping by cancelling the reader keeps the loop down to the one promise
    // it has to await anyway. Racing a longer-lived promise per chunk would
    // attach a reaction per chunk, making the cost of a body scale with the
    // framing the client chose rather than with the bytes maxBytes bounds.
    let interrupted: "disconnected" | "idle" | undefined;
    const interrupt = (reason: "disconnected" | "idle", because: string) => {
      if (interrupted !== undefined) return;
      interrupted = reason;
      void reader.cancel(new Error(because)).catch(() => {});
    };
    const disconnect = () => interrupt("disconnected", "The client closed the request.");
    // Bound the gap between chunks, not the whole upload: a slow client keeps
    // its request, a silent one does not keep the handler.
    const idleTimer = setTimeout(() => interrupt("idle", "Request body stalled."), idleMs);
    if (request.signal.aborted) disconnect();
    else request.signal.addEventListener("abort", disconnect, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        // Cancelling resolves the pending read as done, so why the read ended
        // has to be settled before a done is taken at face value.
        if (interrupted === "disconnected") throw clientClosedRequest();
        if (interrupted === "idle") {
          throw new GatewayError({
            message: `The request body stopped arriving for ${idleMs}ms.`,
            status: 408,
            type: "invalid_request_error",
            code: "body_timeout",
          });
        }
        if (done) break;
        idleTimer.refresh();
        total += value.byteLength;
        if (total > maxBytes) {
          // Tearing down a broken stream can reject; that must not cost the
          // caller the reason its request was refused.
          await reader.cancel(new Error("Request body too large.")).catch(() => {});
          throw bodyTooLarge(maxBytes);
        }
        chunks.push(value);
      }
    } catch (error) {
      // A peer that vanishes mid-upload surfaces as a stream error. The
      // gateway did nothing wrong, so it reports a closed request rather than
      // a fault of its own.
      if (error instanceof GatewayError) throw error;
      throw clientClosedRequest(error);
    } finally {
      clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", disconnect);
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

    const cors = corsHeaders(request, config.server.allow_origin);
    // Only while CORS is switched on. Answering a preflight before the auth
    // gate is right for a browser flow and wrong for everyone else: off, the
    // gate has to keep applying to every method.
    if (
      config.server.allow_origin !== undefined &&
      request.method === "OPTIONS" &&
      SHARED_PATHS.has(url.pathname)
    ) {
      return withCors(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "authorization, content-type, x-request-id",
            "access-control-max-age": "600",
          },
        }),
        cors,
      );
    }

    if (url.pathname === "/healthz") return withCors(Response.json({ status: "ok" }), cors);
    if (url.pathname === "/readyz") {
      const circuits = router.circuitStates();
      return withCors(
        Response.json({
          // Demoted is not removed - a cooling provider is still tried, and other
          // targets still serve - so readiness does not flip and pull the process
          // out of rotation over it.
          status: "ready",
          providers: Object.keys(config.providers).length,
          circuit_breaker: {
            enabled: circuits.enabled,
            open: circuits.providers.filter((p) => p.open).map((p) => p.id),
          },
        }),
        cors,
      );
    }
    if (url.pathname === "/metrics") {
      return withCors(
        new Response(metrics.render(router.circuitStates().providers), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        }),
        cors,
      );
    }
    if (url.pathname === "/") {
      return withCors(Response.json({ name: "TinyRouter", version: VERSION, status: "ok" }), cors);
    }

    if (url.pathname.startsWith("/v1/") && !authorized(request, config.server.api_key)) {
      return withCors(
        errorResponse(
          new GatewayError({
            message: "Invalid or missing API key.",
            status: 401,
            type: "authentication_error",
            code: "invalid_api_key",
          }),
          id,
        ),
        // A shared endpoint shares its refusals too, or a browser reports a
        // CORS failure for what is really a bad key and the operator debugs
        // the wrong thing.
        SHARED_PATHS.has(url.pathname) ? cors : {},
      );
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return withCors(
        Response.json(
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
        ),
        cors,
      );
    }

    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return withCors(
        errorResponse(
          new GatewayError({
            message: "Endpoint not found.",
            status: 404,
            type: "invalid_request_error",
            code: "not_found",
          }),
          id,
        ),
        // As with a refused key: a shared endpoint shares the reason it said
        // no, or the browser reports CORS and the wrong thing gets debugged.
        SHARED_PATHS.has(url.pathname) ? cors : {},
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
