# Configuration

[← TinyRouter](../README.md) · [Configuration](configuration.md) · [Routing](routing.md) · [Operations](operations.md) · [Development](development.md)

```yaml
server:
  host: ${TINYROUTER_HOST:-127.0.0.1}
  port: 8080
  api_key: ${TINYROUTER_API_KEY}
  protect_observability: false
  max_body_bytes: 10485760
  idle_timeout_seconds: 0
  body_timeout_ms: 30000

routing:
  retries: 0
  retry_statuses: [429, 500, 502, 503, 504, 529]
  backoff_initial_ms: 200
  backoff_max_ms: 2000
  circuit_breaker:
    failures: 0
    cooldown_ms: 30000

providers:
  openai:
    type: openai
    api_key: ${OPENAI_API_KEY}
    timeout_ms: 60000

  anthropic:
    type: anthropic
    api_key: ${ANTHROPIC_API_KEY}
    timeout_ms: 60000

  gemini:
    type: gemini
    api_key: ${GEMINI_API_KEY}
    timeout_ms: 60000

  local:
    type: openai-compatible
    base_url: http://localhost:11434/v1

routes:
  fast:
    - openai/gpt-5-mini
    - anthropic/claude-haiku-4-5

  private:
    - local/qwen3
```

`server.allow_origin` lists browser origins allowed to read the observability endpoints — `/`, `/healthz`, `/readyz`, `/metrics`, and `/v1/models` — so a page such as a status dashboard can be served from somewhere else. Omit it and no response carries CORS headers at all. Origins are normalised to the form a browser actually sends, so `https://UI.Example/` is stored and matched as `https://ui.example`; `*`, and anything carrying a path or query, are rejected when the configuration loads rather than silently matching more than you wrote. With no origins configured, `OPTIONS` behaves exactly as it did before the option existed. `/v1/chat/completions` is never shared, whatever is listed. That is deliberate — `api_key` is optional, so a gateway may be running open on localhost, and a page that could reach completions cross-origin could spend your provider credit. Refusals on shared endpoints carry the headers too, so a bad key reports as `401` rather than as a CORS failure.

Environment placeholders use `${NAME}`. `${NAME:-fallback}` is also supported. Configuration loading fails if a required variable is absent.

The native `openai`, `anthropic`, and `gemini` provider types require `api_key`. The `openai-compatible` type does not, so it can route to local servers. Every provider accepts optional static `headers`, `base_url`, and `timeout_ms` values.

`idle_timeout_seconds` defaults to `0`, disabling Bun's connection-idle timer so a model may think or pause for more than ten seconds without losing an SSE stream. Set it to `1`–`255` only if you intentionally want a global idle limit.

`timeout_ms` bounds provider progress rather than total duration: a provider has that long to return response headers, and then that long again for each gap between chunks of the body. A response may therefore take as long as the model needs, but a provider that accepts a request and goes silent is cut loose instead of holding the connection open forever. Any byte counts as progress, including the keepalive pings providers send while a model is thinking. When a stalled response is a stream, the client receives a terminating `provider_timeout_error` event; otherwise the body simply ends. TinyRouter still never switches providers once a response has begun — a stall ends the request rather than retrying it, because the client has already received part of the answer.

A client that disconnects or cancels — the stop button in a chat UI, a closed tab — ends the request with `499 client_closed_request`, whether it happens while the request body is still arriving, while a provider is answering, or while TinyRouter is waiting to retry one. That is never counted against the provider: it is not retried, not recorded as a provider attempt, and never counts toward a circuit breaker, since the provider did nothing wrong.

`body_timeout_ms` bounds the gap between request-body chunks, so an upload that is merely slow keeps its request while one that stops arriving is answered with `408` instead of holding a handler open. `max_body_bytes` bounds how large a body may be; this bounds how long it may go quiet.

When `retries` is greater than zero, TinyRouter waits before retrying the same target: the provider's `Retry-After` (or `retry-after-ms`) when it sends one, otherwise an exponentially growing jittered delay starting at `backoff_initial_ms`. Either way a single wait never exceeds `backoff_max_ms`, so a provider announcing a long cooldown cannot hold a client request hostage, and a disconnecting client cancels the wait. Falling back to a different target is always immediate — its capacity is unrelated to the failure that triggered the fallback. Set `backoff_max_ms: 0` to restore immediate retries.

Use `tinyrouter --check --config tinyrouter.yaml` to validate a file. `--print-config` shows the resolved configuration with API keys redacted.

# Circuit breaking

While a provider is down, every request pays its full `timeout_ms` before falling back. Setting `circuit_breaker.failures` to a positive number stops that: after that many consecutive failing requests, a provider is demoted to a last resort for `cooldown_ms`, so healthy targets are tried first and a provider that is down usually costs nothing at all.

It is off by default, because it is the one place where routing depends on what earlier requests did rather than only on the current one. Six rules keep it predictable:

- **Failing requests are counted, not failing attempts.** Retries of one request are one piece of evidence about a provider, so `retries` never changes the effective threshold.
- **A cooling provider is demoted, never removed.** It moves to the back of the route rather than being skipped, so a request is never failed with an untried target left over — whether the other targets failed, were filtered, or were cooling too.
- **Server errors count; client errors do not.** A `5xx` is a provider failure whether or not you retry it, while a `4xx` is the client's problem and proves the provider is alive, which clears earlier failures — though not ones this same request already recorded.
- **A delivered response is what counts as success, not a prompt set of headers.** A provider that answers and then stalls, or drops the body part-way, has failed — it costs a client strictly more than one that never answers, so it is demoted the same way.
- **A client that leaves mid-answer is evidence of neither.** Content having arrived does not prove the provider was still working when the reader gave up: one that sends a token and then hangs looks exactly like one the reader simply stopped, and crediting that would clear the strikes of the provider the breaker exists to demote. The cost of being conservative here is that a stream nobody finishes cannot clear an earlier failure either, so in traffic where most generations are stopped early, failures clear only when some request runs to completion.
- **A success closes the circuit, unless the same request just failed.** Once the cooldown elapses the next request probes the provider, and a single further failure reopens it for another full cooldown. A success does not erase a failure from its own request, so a provider whose first attempt always fails and whose retry always works is still demoted — that wasted attempt is exactly what the breaker is for.

The state is in-memory and per process: nothing is persisted, and a restart starts clean. A positive `failures` requires a positive `cooldown_ms`, since a zero cooldown would skip nothing while reading as enabled.

# Request filters

Optional deterministic filters inspect requests before routing. `block` rejects a request with a 400 naming the rule; `redact` replaces matches with a marker:

```yaml
filters:
  - type: block
    patterns: [anthropic_api_key, openai_api_key, aws_access_key, github_token, private_key]
  - type: redact
    patterns: [email, e164_phone, credit_card]
    providers: [openai, anthropic, gemini]
  - type: redact
    name: employee_id
    pattern: "EMP-[0-9]{6}"
```

The contract: filters run in configured order, once per request per provider, over content-bearing text only — string message content, the text of text parts, and tool-call arguments (both `tool_calls` and legacy `function_call`). Structural fields such as roles, names, ids, and image URLs are never scanned, and fields outside `messages` are never touched. Tool-call arguments are redacted inside their parsed JSON, so redaction cannot corrupt them; arguments that are not valid JSON are redacted as text.

A filter with a `providers` list applies only when the attempt targets one of those providers, so a route like `[local/qwen3, anthropic/claude-haiku-4-5]` can send full content to your own hardware and redact only what leaves for the cloud; a filter without `providers` applies everywhere.

A firing block means *that target* may not receive the content, so the target is skipped and routing continues — a block scoped to one provider never vetoes the others. The request fails with a 400 naming the rule only when no target can serve it, and a real failure from a target that was actually tried is reported instead of the block, so an outage is never disguised as a client error. Blocked targets appear in the attempt log with outcome `blocked`, and are never counted as upstream provider attempts.

Redactions become a visible `[redacted:<name>]` marker (or a custom `replacement`), a per-attempt count in the request log, and an `x-tinyrouter-redactions` response header for the attempt that served the response, so silent prompt alteration is never invisible. Neither blocks nor logs ever contain the matched text. Streaming responses are not filtered: in the chat completions loop everything a model can echo — system prompts, user content, tool results — transits the gateway as a request first, so outbound filtering is where the boundary is.

This is pattern redaction, not PII detection: the built-ins (`email`, `e164_phone`, `credit_card`, plus the credential patterns above) are deterministic, high-precision shapes with bounded quantifiers so no input can make scanning super-linear, and no regex finds names or addresses. `credit_card` matches shape only, without a Luhn check. For semantic guardrails or real DLP, use one of the tools in the comparison table in the [README](../README.md#when-to-use-tinyrouter).

# Finding model IDs

A target's model half is passed to the provider verbatim, so it must be a model ID that provider currently serves to your account. Model IDs change over time, and the ones in `tinyrouter.example.yaml` are illustrative — an ID your key cannot reach comes back as a `404` from the provider, not as a configuration error. To list what your keys can actually reach:

```bash
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/models
```

```bash
curl -s -H "authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
```

```bash
curl -s -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models
```

Appearing in that catalog does not guarantee access: a model retired for new accounts is still listed but answers `404` when called. Some providers also publish floating aliases, such as Gemini's `gemini-flash-latest`, which track the current model and avoid this kind of drift at the cost of a moving target.

TinyRouter's own `GET /v1/models` is a different list: it reports the aliases and targets in your configuration, not the catalog a provider offers.
