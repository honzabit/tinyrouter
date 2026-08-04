import type { TinyRouterConfig } from "./config.ts";
import { GatewayError } from "./errors.ts";
import { createFilterChain, filtersForProvider } from "./filters.ts";
import type { Metrics } from "./metrics.ts";
import type { ProviderAdapter } from "./providers/provider.ts";
import { withStallTimeout } from "./sse.ts";
import type { AttemptRecord, ChatCompletionRequest, ResolvedTarget, RoutedResponse } from "./types.ts";

export type Fetch = (request: Request) => Promise<Response>;
export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

export function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const msHeader = headers.get("retry-after-ms");
  if (msHeader !== null) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  const header = headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  // A numeric value is a duration in seconds; a negative one is malformed and
  // must not fall through to date parsing, which would read it as a year.
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

// The provider's Retry-After wins when it is longer than the computed step;
// either way the wait never exceeds maxMs, so a hostile Retry-After cannot
// hold a client request hostage. Jitter keeps concurrent retries apart.
export function retryBackoffMs(options: {
  attempt: number;
  initialMs: number;
  maxMs: number;
  retryAfterMs?: number | undefined;
  random?: () => number;
}): number {
  const step = Math.min(options.maxMs, options.initialMs * 2 ** options.attempt);
  const random = options.random ?? Math.random;
  const jittered = step === 0 ? 0 : Math.round(step / 2 + random() * (step / 2));
  return Math.min(options.maxMs, Math.max(jittered, options.retryAfterMs ?? 0));
}

// Resolves early when the signal aborts so a disconnected client never keeps
// the gateway sleeping; the caller checks the signal after waiting.
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// Applies to every response with a body, streaming or not: a passthrough
// adapter hands back the upstream body unread, so a provider can stall
// part-way through a plain JSON response just as easily as an SSE one.
function watchStall(response: Response, timeoutMs: number, controller: AbortController): Response {
  if (response.body === null) return response;
  const sse = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
  const body = withStallTimeout(
    response.body,
    timeoutMs,
    () => controller.abort(new Error(`Provider sent no data for ${timeoutMs}ms.`)),
    { sse },
  );
  return new Response(body, { status: response.status, headers: response.headers });
}

function splitTarget(target: string): ResolvedTarget {
  const slash = target.indexOf("/");
  return {
    providerId: target.slice(0, slash),
    model: target.slice(slash + 1),
    label: target,
  };
}

function attemptOutcome(options: { canRetry: boolean; hasFallback: boolean }): AttemptRecord["outcome"] {
  if (options.canRetry) return "retry";
  if (options.hasFallback) return "fallback";
  return "error";
}

function failureWithAttempts(error: GatewayError, attempts: AttemptRecord[]): GatewayError {
  return new GatewayError({
    message: error.message,
    status: error.status,
    type: error.type,
    ...(error.code === undefined ? {} : { code: error.code }),
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
    attempts,
    cause: error,
  });
}

export class Router {
  // Filters are scoped per provider, so each provider gets its own chain,
  // compiled once at construction.
  private readonly filterChains: Map<string, ReturnType<typeof createFilterChain>>;

  constructor(
    private readonly config: TinyRouterConfig,
    private readonly adapters: Map<string, ProviderAdapter>,
    private readonly metrics: Metrics,
    private readonly fetchFn: Fetch = fetch,
    private readonly waitFn: Wait = abortableSleep,
  ) {
    this.filterChains = new Map(
      [...adapters.keys()].map((id) => [id, createFilterChain(filtersForProvider(config.filters, id))]),
    );
  }

  resolve(modelOrAlias: string): ResolvedTarget[] {
    const route = this.config.routes[modelOrAlias];
    if (route !== undefined) return route.map(splitTarget);

    const slash = modelOrAlias.indexOf("/");
    if (slash < 1 || slash === modelOrAlias.length - 1) {
      throw new GatewayError({
        message: `Unknown model or route '${modelOrAlias}'.`,
        status: 404,
        type: "model_not_found",
        code: "model_not_found",
      });
    }
    const target = splitTarget(modelOrAlias);
    if (!this.adapters.has(target.providerId)) {
      throw new GatewayError({
        message: `Unknown provider '${target.providerId}'.`,
        status: 404,
        type: "model_not_found",
        code: "provider_not_found",
      });
    }
    return [target];
  }

  listModels(): Array<{ id: string; targets: string[]; kind: "route" | "target" }> {
    const aliases = Object.entries(this.config.routes).map(([id, targets]) => ({
      id,
      targets: [...targets],
      kind: "route" as const,
    }));
    const targets = [...new Set(Object.values(this.config.routes).flat())]
      .sort()
      .map((id) => ({ id, targets: [id], kind: "target" as const }));
    return [...aliases, ...targets].sort((a, b) => a.id.localeCompare(b.id));
  }

  async route(input: ChatCompletionRequest, callerSignal: AbortSignal): Promise<RoutedResponse> {
    const targets = this.resolve(input.model);
    const attempts: AttemptRecord[] = [];
    const filteredByProvider = new Map<string, { input: ChatCompletionRequest; redactions: number }>();
    let lastError: GatewayError | undefined;
    let blockError: GatewayError | undefined;

    for (const [targetIndex, target] of targets.entries()) {
      const adapter = this.adapters.get(target.providerId);
      if (adapter === undefined) continue;

      // Filter before contacting the provider, and outside the attempt loop:
      // a block means this target may not receive this content, so the target
      // is skipped like an unusable one rather than failing the whole request.
      // A filter scoped to one provider must not veto the others.
      let filtered = filteredByProvider.get(target.providerId);
      if (filtered === undefined) {
        const chain = this.filterChains.get(target.providerId);
        if (chain === undefined) {
          // Fail closed: a provider with no chain must never receive content
          // that the configuration says should have been filtered.
          throw new GatewayError({
            message: `No filter chain configured for provider '${target.providerId}'.`,
            status: 500,
            type: "api_error",
          });
        }
        const filterStartedAt = performance.now();
        try {
          filtered = chain(input);
        } catch (caught) {
          if (!(caught instanceof GatewayError)) throw caught;
          blockError = caught;
          attempts.push({
            target: target.label,
            attempt: 1,
            durationMs: Math.round(performance.now() - filterStartedAt),
            outcome: "blocked",
            errorType: caught.type,
          });
          continue;
        }
        filteredByProvider.set(target.providerId, filtered);
      }
      const redacted = filtered.redactions > 0 ? { redactions: filtered.redactions } : {};

      for (let retry = 0; retry <= this.config.routing.retries; retry += 1) {
        const startedAt = performance.now();
        const attemptNumber = retry + 1;
        const hasRetry = retry < this.config.routing.retries;
        const hasFallback = targetIndex < targets.length - 1;
        let timedOut = false;
        const controller = new AbortController();
        if (callerSignal.aborted) controller.abort(callerSignal.reason);
        else
          callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Provider response timeout after ${adapter.timeoutMs}ms.`));
        }, adapter.timeoutMs);

        try {
          const upstreamRequest = adapter.createRequest(filtered.input, target.model, controller.signal);
          const upstreamResponse = await this.fetchFn(upstreamRequest);
          const durationMs = Math.round(performance.now() - startedAt);

          if (upstreamResponse.ok) {
            const normalized = await adapter.normalizeResponse(
              upstreamResponse,
              filtered.input,
              target.model,
            );
            clearTimeout(timer);
            // The header timeout is done, but the body is still arriving:
            // hold the provider to the same budget for every gap in it.
            const served = watchStall(normalized, adapter.timeoutMs, controller);
            attempts.push({
              target: target.label,
              attempt: attemptNumber,
              status: upstreamResponse.status,
              durationMs,
              outcome: "success",
              ...redacted,
            });
            this.metrics.attempt({
              provider: target.providerId,
              model: target.model,
              status: String(upstreamResponse.status),
            });
            return { response: served, target, attempts, redactions: filtered.redactions };
          }

          clearTimeout(timer);
          const error = await adapter.parseError(upstreamResponse);
          lastError = error;
          const canMove = this.config.routing.retry_statuses.includes(upstreamResponse.status);
          const willRetry = canMove && hasRetry;
          const backoffMs = willRetry
            ? retryBackoffMs({
                attempt: retry,
                initialMs: this.config.routing.backoff_initial_ms,
                maxMs: this.config.routing.backoff_max_ms,
                retryAfterMs: parseRetryAfter(upstreamResponse.headers, Date.now()),
              })
            : 0;
          const outcome = attemptOutcome({
            canRetry: willRetry,
            hasFallback: canMove && hasFallback,
          });
          attempts.push({
            target: target.label,
            attempt: attemptNumber,
            status: upstreamResponse.status,
            durationMs,
            outcome,
            errorType: error.type,
            ...(backoffMs > 0 ? { retryDelayMs: backoffMs } : {}),
            ...redacted,
          });
          this.metrics.attempt({
            provider: target.providerId,
            model: target.model,
            status: String(upstreamResponse.status),
          });
          if (!canMove) throw failureWithAttempts(error, attempts);
          if (hasRetry) {
            if (backoffMs > 0) {
              await this.waitFn(backoffMs, callerSignal);
              if (callerSignal.aborted) throw failureWithAttempts(error, attempts);
            }
            continue;
          }
          break;
        } catch (caught) {
          clearTimeout(timer);
          if (caught instanceof GatewayError && caught.attempts !== undefined) throw caught;
          const durationMs = Math.round(performance.now() - startedAt);
          const error =
            caught instanceof GatewayError
              ? caught
              : new GatewayError({
                  message: timedOut
                    ? `Provider '${target.providerId}' timed out before completing its response.`
                    : `Could not reach provider '${target.providerId}'.`,
                  status: timedOut ? 504 : 502,
                  type: timedOut ? "provider_timeout_error" : "provider_error",
                  retryable: true,
                  cause: caught,
                });
          lastError = error;
          const canMove = error.retryable;
          const willRetry = canMove && hasRetry;
          const backoffMs = willRetry
            ? retryBackoffMs({
                attempt: retry,
                initialMs: this.config.routing.backoff_initial_ms,
                maxMs: this.config.routing.backoff_max_ms,
              })
            : 0;
          const outcome = attemptOutcome({
            canRetry: willRetry,
            hasFallback: canMove && hasFallback,
          });
          attempts.push({
            target: target.label,
            attempt: attemptNumber,
            durationMs,
            outcome,
            errorType: error.type,
            ...(backoffMs > 0 ? { retryDelayMs: backoffMs } : {}),
            ...redacted,
          });
          this.metrics.attempt({
            provider: target.providerId,
            model: target.model,
            status: timedOut
              ? "timeout"
              : caught instanceof GatewayError
                ? String(error.status)
                : "network_error",
          });
          if (!canMove) throw failureWithAttempts(error, attempts);
          if (hasRetry) {
            if (backoffMs > 0) {
              await this.waitFn(backoffMs, callerSignal);
              if (callerSignal.aborted) throw failureWithAttempts(error, attempts);
            }
            continue;
          }
          break;
        }
      }
    }

    // A real provider failure outranks a block: if another target actually
    // tried and failed, that is the honest outcome to report.
    throw failureWithAttempts(
      lastError ??
        blockError ??
        new GatewayError({
          message: "No configured provider could serve this request.",
          status: 503,
          type: "service_unavailable",
        }),
      attempts,
    );
  }
}
