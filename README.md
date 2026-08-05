# TinyRouter

TinyRouter is a small, auditable, self-hosted LLM gateway. Bring your own provider keys, expose one OpenAI-compatible endpoint, and describe deterministic fallbacks in YAML.

It is intended to feel like **Caddy for LLM APIs**: one process, one configuration file, and very little magic.

> **Status:** alpha. The routing contract is unit-tested and smoke-checked against live providers on every release, but TinyRouter has not yet been exercised under production traffic.

## What it does

- Exposes `POST /v1/chat/completions` and `GET /v1/models`
- Works with clients that can target an OpenAI-compatible base URL
- Supports streaming and non-streaming responses
- Supports OpenAI, Anthropic, Gemini, and generic OpenAI-compatible providers
- Translates text, images, and function/tool calls for Anthropic and Gemini
- Resolves friendly model aliases to ordered provider/model targets
- Retries and falls back only before a response has started
- Emits structured logs without prompts or completions
- Exposes health, readiness, and dependency-free Prometheus metrics
- Runs from TypeScript with Bun or compiles into a standalone executable

TinyRouter has no accounts, billing, credits, database, Redis, dashboard, semantic router, or background control plane.

## When to use TinyRouter

TinyRouter occupies a deliberate niche: deterministic model fallback behind one OpenAI-compatible endpoint, in a process small enough to read before you hand it your API keys.

Use it when:

- **You want to audit the thing that holds your keys.** A gateway sits between your provider credentials and every prompt you send. TinyRouter is roughly 2,200 lines of TypeScript (plus 800 of tests) with two runtime dependencies, `yaml` and `zod` — one person can read all of it in an evening.
- **You refuse to run infrastructure for a proxy.** One process, one YAML file. No database, no Redis, no admin UI. Prometheus metrics are built in, and the compiled binary runs with nothing else installed.
- **You run local models with cloud fallback.** Serve your own model first and fail over to a hosted one only when it is down or overloaded:

  ```yaml
  routes:
    assistant:
      - local/qwen3
      - anthropic/claude-haiku-4-5
  ```

- **You need failover you can reason about.** The routing contract fits in a paragraph and never switches providers mid-stream. What triggers a retry is a configured status list, not a heuristic.
- **Clients you don't control need one stable endpoint.** Open WebUI, LibreChat, editors, agents — anything that accepts an OpenAI base URL gets model aliases and failover with no code changes.

Use something else when:

| You need | Better fit |
| --- | --- |
| Budgets, virtual keys, per-user spend tracking, an admin UI | [LiteLLM](https://github.com/BerriAI/litellm) |
| Guardrails, semantic caching, prompt management | [Portkey](https://github.com/Portkey-AI/gateway) |
| A hosted gateway with nothing to operate | [OpenRouter](https://openrouter.ai), [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) |
| A hundred providers out of the box | LiteLLM or a hosted gateway |
| Provider switching inside one app whose code you control | An SDK such as the [AI SDK](https://ai-sdk.dev) — you may not need a proxy at all |

Those are good projects, and TinyRouter is not trying to replace them. It exists for the case where the feature you want most is being able to understand the whole thing.

## Install

Every release attaches a standalone executable for Linux and macOS on x64 and arm64, alongside a `SHA256SUMS` file. They embed the Bun runtime, so nothing else needs to be installed:

```bash
curl -fsSL https://github.com/honzabit/tinyrouter/releases/latest/download/tinyrouter-linux-x64.tar.gz | tar -xz
```

That leaves a `tinyrouter` executable in the working directory. Swap `linux-x64` for `linux-arm64`, `darwin-x64`, or `darwin-arm64` as needed, and check a download against `SHA256SUMS`.

On macOS, extract with `tar` as above rather than double-clicking the archive: Finder copies its quarantine flag onto the extracted executable, and Gatekeeper then reports the executable as damaged because these builds are ad-hoc signed rather than notarized.

### Container

Every release also publishes a multi-architecture image (amd64 and arm64) to the GitHub Container Registry:

```bash
docker run --rm -p 8080:8080 --env-file .env \
  -v "$PWD/tinyrouter.yaml:/etc/tinyrouter/tinyrouter.yaml:ro" \
  ghcr.io/honzabit/tinyrouter:latest
```

```yaml
services:
  tinyrouter:
    image: ghcr.io/honzabit/tinyrouter:latest
    ports: ["8080:8080"]
    env_file: .env
    volumes:
      - ./tinyrouter.yaml:/etc/tinyrouter/tinyrouter.yaml:ro
    restart: unless-stopped
```

`0.1.1` pins one release, `0.1` follows its patches, and `latest` follows the newest release; prereleases are only ever published under their exact version. The image runs as a non-root user and holds nothing but the executable and CA certificates.

To run from source instead, follow the quick start below.

## Quick start

You need [Bun](https://bun.sh/) 1.3.14 or later.

```bash
bun install
cp tinyrouter.example.yaml tinyrouter.yaml

export TINYROUTER_API_KEY=local-secret
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=...

bun run start
```

Call an alias exactly as you would call a model:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'Authorization: Bearer local-secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "Explain this error"}],
    "stream": true
  }'
```

Or use an OpenAI client with a custom base URL. TinyRouter implements the Chat Completions shape documented in the [official API reference](https://developers.openai.com/api/reference/chat-completions/overview/).

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local-secret",
  baseURL: "http://localhost:8080/v1",
});

const completion = await client.chat.completions.create({
  model: "smart",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Configuration

```yaml
server:
  host: 0.0.0.0
  port: 8080
  api_key: ${TINYROUTER_API_KEY}
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

Environment placeholders use `${NAME}`. `${NAME:-fallback}` is also supported. Configuration loading fails if a required variable is absent.

The native `openai`, `anthropic`, and `gemini` provider types require `api_key`. The `openai-compatible` type does not, so it can route to local servers. Every provider accepts optional static `headers`, `base_url`, and `timeout_ms` values.

`idle_timeout_seconds` defaults to `0`, disabling Bun's connection-idle timer so a model may think or pause for more than ten seconds without losing an SSE stream. Set it to `1`–`255` only if you intentionally want a global idle limit.

`timeout_ms` bounds provider progress rather than total duration: a provider has that long to return response headers, and then that long again for each gap between chunks of the body. A response may therefore take as long as the model needs, but a provider that accepts a request and goes silent is cut loose instead of holding the connection open forever. Any byte counts as progress, including the keepalive pings providers send while a model is thinking. When a stalled response is a stream, the client receives a terminating `provider_timeout_error` event; otherwise the body simply ends. TinyRouter still never switches providers once a response has begun — a stall ends the request rather than retrying it, because the client has already received part of the answer.

A client that disconnects or cancels — the stop button in a chat UI, a closed tab — ends the request with `499 client_closed_request`, whether it happens while the request body is still arriving, while a provider is answering, or while TinyRouter is waiting to retry one. That is never counted against the provider: it is not retried, not recorded as a provider attempt, and never counts toward a circuit breaker, since the provider did nothing wrong.

`body_timeout_ms` bounds the gap between request-body chunks, so an upload that is merely slow keeps its request while one that stops arriving is answered with `408` instead of holding a handler open. `max_body_bytes` bounds how large a body may be; this bounds how long it may go quiet.

When `retries` is greater than zero, TinyRouter waits before retrying the same target: the provider's `Retry-After` (or `retry-after-ms`) when it sends one, otherwise an exponentially growing jittered delay starting at `backoff_initial_ms`. Either way a single wait never exceeds `backoff_max_ms`, so a provider announcing a long cooldown cannot hold a client request hostage, and a disconnecting client cancels the wait. Falling back to a different target is always immediate — its capacity is unrelated to the failure that triggered the fallback. Set `backoff_max_ms: 0` to restore immediate retries.

Use `tinyrouter --check --config tinyrouter.yaml` to validate a file. `--print-config` shows the resolved configuration with API keys redacted.

### Circuit breaking

While a provider is down, every request pays its full `timeout_ms` before falling back. Setting `circuit_breaker.failures` to a positive number stops that: after that many consecutive failing requests, a provider is demoted to a last resort for `cooldown_ms`, so healthy targets are tried first and a provider that is down usually costs nothing at all.

It is off by default, because it is the one place where routing depends on what earlier requests did rather than only on the current one. Six rules keep it predictable:

- **Failing requests are counted, not failing attempts.** Retries of one request are one piece of evidence about a provider, so `retries` never changes the effective threshold.
- **A cooling provider is demoted, never removed.** It moves to the back of the route rather than being skipped, so a request is never failed with an untried target left over — whether the other targets failed, were filtered, or were cooling too.
- **Server errors count; client errors do not.** A `5xx` is a provider failure whether or not you retry it, while a `4xx` is the client's problem and proves the provider is alive, which clears earlier failures — though not ones this same request already recorded.
- **A delivered response is what counts as success, not a prompt set of headers.** A provider that answers and then stalls, or drops the body part-way, has failed — it costs a client strictly more than one that never answers, so it is demoted the same way.
- **A client that leaves mid-answer is evidence of neither.** Content having arrived does not prove the provider was still working when the reader gave up: one that sends a token and then hangs looks exactly like one the reader simply stopped, and crediting that would clear the strikes of the provider the breaker exists to demote. The cost of being conservative here is that a stream nobody finishes cannot clear an earlier failure either, so in traffic where most generations are stopped early, failures clear only when some request runs to completion.
- **A success closes the circuit, unless the same request just failed.** Once the cooldown elapses the next request probes the provider, and a single further failure reopens it for another full cooldown. A success does not erase a failure from its own request, so a provider whose first attempt always fails and whose retry always works is still demoted — that wasted attempt is exactly what the breaker is for.

The state is in-memory and per process: nothing is persisted, and a restart starts clean. A positive `failures` requires a positive `cooldown_ms`, since a zero cooldown would skip nothing while reading as enabled.

### Request filters

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

This is pattern redaction, not PII detection: the built-ins (`email`, `e164_phone`, `credit_card`, plus the credential patterns above) are deterministic, high-precision shapes with bounded quantifiers so no input can make scanning super-linear, and no regex finds names or addresses. `credit_card` matches shape only, without a Luhn check. For semantic guardrails or real DLP, use the tools in the table above.

### Finding model IDs

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

## Routing contract

A request can name either an alias such as `smart` or a direct target such as `anthropic/claude-sonnet-4-6`.

For each request TinyRouter:

1. Resolves the alias to its ordered targets.
2. Calls the first target.
3. Retries it only when the status is configured in `retry_statuses` or the connection fails.
4. Waits between retries of the same target — the provider's `Retry-After` when sent, a jittered exponential delay otherwise, never longer than `backoff_max_ms`.
5. Moves to the next target only for those same retryable failures, without waiting.
6. Stops immediately on authentication and ordinary request errors.
7. Commits to a provider as soon as that provider returns a successful response.

TinyRouter never switches providers after a stream has begun. Mid-stream errors remain stream errors; replaying the request against another model could duplicate output or tool calls.

The response includes:

- `x-request-id`
- `x-tinyrouter-provider`
- `x-tinyrouter-model`

Structured logs record target attempts, status, latency, and routing outcome. They do not record request or response bodies.

## Providers

| Type | Request behavior | Response behavior |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions passthrough | Passthrough |
| `openai-compatible` | Configurable OpenAI-shaped endpoint | Passthrough |
| `anthropic` | Translates messages, tools, and common generation options | Normalizes JSON and SSE |
| `gemini` | Translates messages, tools, common options, and JSON response format | Normalizes JSON and SSE |

The generic OpenAI-compatible adapter passes unknown request fields through unchanged. Native adapters intentionally support a smaller common subset; provider-specific features that have no safe cross-provider representation are not silently invented.

Images are translated for both native adapters: Anthropic accepts http(s) URLs and base64 `data:` URIs, Gemini accepts base64 `data:` URIs. Content parts that have no representation for the selected provider are rejected with a 400 `unsupported_content` error rather than silently dropped, so clients never talk to a silently blind model.

## Operations

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `POST /v1/chat/completions` | Configured bearer token | Inference |
| `GET /v1/models` | Configured bearer token | Routes and referenced targets |
| `GET /healthz` | None | Process health |
| `GET /readyz` | None | Configuration readiness |
| `GET /metrics` | None | Prometheus metrics |

`/readyz` verifies that configuration and provider adapters loaded. It deliberately does not send paid health-check requests to providers.

`/metrics` reports request and attempt counters, plus `tinyrouter_tokens_total{provider,model,kind}` for the tokens providers report, so spend can be attributed per model without a database. Tokens are counted as the response passes through, never by altering it.

`tinyrouter_response_bodies_total{provider,model,outcome}` records how each response body ended — `completed`, `stalled`, `failed`, or `cancelled`. The status line is sent before any of that is known, so a provider that answers `200` and then hangs looks healthy in the request and attempt counters; this is where that shows up, and it is the same signal the circuit breaker acts on.

`tinyrouter_circuit_open{provider}` is `1` while the breaker has a provider demoted and `0` otherwise, read from the breaker at scrape time rather than stored — a circuit closes when its cooldown elapses, not on an event. Every configured provider gets a series, since an absent one is indistinguishable from a scrape that never happened. `/readyz` carries the same state as `circuit_breaker: { enabled, open: [...] }` for a quick look without a scraper. Readiness itself stays `ready` while a provider is cooling: demoted is not removed, the gateway still serves, and flipping it would pull the process out of rotation over something that is not an outage.

Completions always report usage. **A streaming request reports usage only when the client sets `stream_options.include_usage`** — without that flag the provider never sends the numbers, so there is nothing to count. TinyRouter reports what it observes rather than estimating, so enable that flag in your client if you want streaming traffic to appear in the token counters. Counts that are not whole non-negative numbers are discarded rather than recorded, and a client that disconnects mid-stream still has whatever the provider already generated counted against it.

TinyRouter logs a warning at startup when `server.api_key` is unset and the host is not loopback — that combination leaves `/v1` endpoints open to anyone who can reach the address. On SIGINT or SIGTERM it drains in-flight requests, including active streams, for up to ten seconds before closing the remaining connections.

TinyRouter does not terminate TLS. Put it behind a trusted reverse proxy when it is reachable outside a private machine or network. Protect the metrics endpoint separately if operational metadata is sensitive in your environment.

## Build and test

```bash
bun run check
bun run lint
bun run knip
bun test
bun run build
./dist/tinyrouter --version
```

`check` type-checks, `lint` runs Biome (formatter and linter; `bun run format` rewrites in place), and `knip` reports unused exports and dependencies. CI runs all of them.

### Smoke tests against real providers

Unit tests mock every upstream. `bun run smoke` complements them with live traffic: it starts a real gateway configured with whichever providers have credentials in the environment, then sends a completion, a streamed completion, and a forced tool call through each one.

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... bun run smoke
```

```bash
SMOKE_LOCAL_BASE_URL=http://localhost:11434/v1 SMOKE_LOCAL_MODEL=qwen2.5:0.5b bun run smoke
```

Providers without credentials are skipped, and the models are overridable via `SMOKE_OPENAI_MODEL`, `SMOKE_ANTHROPIC_MODEL`, and `SMOKE_GEMINI_MODEL`. A check the provider rate limits is reported as skipped rather than failed, since a quota says nothing about the gateway; a run where every check was rate limited still fails, because it verified nothing.

The Smoke workflow runs the same script on demand from the Actions tab, and the release workflow runs it as a gate. One job needs no secrets at all: it installs Ollama on the runner, pulls a small CPU model, and routes real inference through the gateway. The other exercises hosted providers using the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` repository secrets — set whichever you want covered. Model IDs can be overridden per repository with `SMOKE_OPENAI_MODEL`, `SMOKE_ANTHROPIC_MODEL`, `SMOKE_GEMINI_MODEL`, and `OLLAMA_MODEL` Actions variables, so a provider retiring a model does not require a code change.

### Releasing

Versions follow semantic versioning, with the caveat that 0.x minor bumps carry the breaking changes. Bump the minor for anything that changes the configuration schema, the routing contract, or an endpoint's shape; bump the patch for fixes.

`package.json` is the only place the version lives — `--version` and `GET /` both read it — so a release is a version bump, a tag, and a push:

```bash
bun run release 0.2.0
```

That script rewrites `package.json`, commits, and creates the annotated tag; pushing it starts the release workflow:

```bash
git push origin main --follow-tags
```

The workflow re-runs the full suite, gates on the live smoke checks, then builds the four archives and publishes the release with a generated changelog. A tag whose name disagrees with `package.json` fails before anything is published, and nothing is released if smoke fails. The workflow can also be dispatched manually with an existing tag to rebuild and attach its executables.

The compiled executable embeds the Bun runtime. It is operationally standalone, although larger than an equivalent Go executable.

Build the container locally, as CI does on every push, rather than pulling the published image:

```bash
docker build -t tinyrouter .
docker run --rm -p 8080:8080 \
  --env-file .env \
  -v "$PWD/tinyrouter.yaml:/etc/tinyrouter/tinyrouter.yaml:ro" \
  tinyrouter
```

## Deliberate omissions

The first release does not implement the Responses API, embeddings, image generation, audio, persistent usage accounting, pricing, budgets, rate limits, caching, a web UI, or multi-user administration.

These are product layers, not prerequisites for a reliable tiny gateway. Additions should preserve the ability to understand the complete routing path without running external infrastructure.

## License

Apache-2.0
