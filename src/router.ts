import type { TinyRouterConfig } from "./config.ts";
import { GatewayError } from "./errors.ts";
import type { Metrics } from "./metrics.ts";
import type { ProviderAdapter } from "./providers/provider.ts";
import type { AttemptRecord, ChatCompletionRequest, ResolvedTarget, RoutedResponse } from "./types.ts";

export type Fetch = (request: Request) => Promise<Response>;

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
  constructor(
    private readonly config: TinyRouterConfig,
    private readonly adapters: Map<string, ProviderAdapter>,
    private readonly metrics: Metrics,
    private readonly fetchFn: Fetch = fetch,
  ) {}

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
    let lastError: GatewayError | undefined;

    for (const [targetIndex, target] of targets.entries()) {
      const adapter = this.adapters.get(target.providerId);
      if (adapter === undefined) continue;

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
          const upstreamRequest = adapter.createRequest(input, target.model, controller.signal);
          const upstreamResponse = await this.fetchFn(upstreamRequest);
          const durationMs = Math.round(performance.now() - startedAt);

          if (upstreamResponse.ok) {
            const normalized = await adapter.normalizeResponse(upstreamResponse, input, target.model);
            clearTimeout(timer);
            attempts.push({
              target: target.label,
              attempt: attemptNumber,
              status: upstreamResponse.status,
              durationMs,
              outcome: "success",
            });
            this.metrics.attempt({
              provider: target.providerId,
              model: target.model,
              status: String(upstreamResponse.status),
            });
            return { response: normalized, target, attempts };
          }

          clearTimeout(timer);
          const error = await adapter.parseError(upstreamResponse);
          lastError = error;
          const canMove = this.config.routing.retry_statuses.includes(upstreamResponse.status);
          const outcome = attemptOutcome({
            canRetry: canMove && hasRetry,
            hasFallback: canMove && hasFallback,
          });
          attempts.push({
            target: target.label,
            attempt: attemptNumber,
            status: upstreamResponse.status,
            durationMs,
            outcome,
            errorType: error.type,
          });
          this.metrics.attempt({
            provider: target.providerId,
            model: target.model,
            status: String(upstreamResponse.status),
          });
          if (!canMove) throw failureWithAttempts(error, attempts);
          if (hasRetry) continue;
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
          const outcome = attemptOutcome({
            canRetry: canMove && hasRetry,
            hasFallback: canMove && hasFallback,
          });
          attempts.push({
            target: target.label,
            attempt: attemptNumber,
            durationMs,
            outcome,
            errorType: error.type,
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
          if (hasRetry) continue;
          break;
        }
      }
    }

    throw failureWithAttempts(
      lastError ??
        new GatewayError({
          message: "No configured provider could serve this request.",
          status: 503,
          type: "service_unavailable",
        }),
      attempts,
    );
  }
}
