# TinyRouter

TinyRouter is a small, auditable, self-hosted LLM gateway. Bring your own provider keys, expose one OpenAI-compatible endpoint, and describe deterministic fallbacks in YAML.

It is intended to feel like **Caddy for LLM APIs**: one process, one configuration file, and very little magic.

> **Status:** v0.1 alpha. The core routing contract is tested, but this release has not yet been exercised under production traffic.

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

routing:
  retries: 0
  retry_statuses: [429, 500, 502, 503, 504]

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

`timeout_ms` bounds how long a provider may take to start responding: it covers the wait for response headers, plus the full body for non-streaming calls. Once a stream has begun, TinyRouter never aborts it mid-response; a client disconnect is propagated upstream instead.

Use `tinyrouter --check --config tinyrouter.yaml` to validate a file. `--print-config` shows the resolved configuration with API keys redacted.

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

TinyRouter's own `GET /v1/models` is a different list: it reports the aliases and targets in your configuration, not the catalog a provider offers.

## Routing contract

A request can name either an alias such as `smart` or a direct target such as `anthropic/claude-sonnet-4-6`.

For each request TinyRouter:

1. Resolves the alias to its ordered targets.
2. Calls the first target.
3. Retries it only when the status is configured in `retry_statuses` or the connection fails.
4. Moves to the next target only for those same retryable failures.
5. Stops immediately on authentication and ordinary request errors.
6. Commits to a provider as soon as that provider returns a successful response.

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

Providers without credentials are skipped, and the models are overridable via `SMOKE_OPENAI_MODEL`, `SMOKE_ANTHROPIC_MODEL`, and `SMOKE_GEMINI_MODEL`.

The Smoke workflow runs the same script on every published release and on demand from the Actions tab. One job needs no secrets at all: it installs Ollama on the runner, pulls a small CPU model, and routes real inference through the gateway. The other exercises hosted providers using the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` repository secrets — set whichever you want covered.

The compiled executable embeds the Bun runtime. It is operationally standalone, although larger than an equivalent Go executable.

Build the container:

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
