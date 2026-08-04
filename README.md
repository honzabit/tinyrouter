# TinyRouter

TinyRouter is a small, auditable, self-hosted LLM gateway. Bring your own provider keys, expose one OpenAI-compatible endpoint, and describe deterministic fallbacks in YAML.

It is intended to feel like **Caddy for LLM APIs**: one process, one configuration file, and very little magic.

> **Status:** v0.1 alpha. The core routing contract is tested, but this release has not yet been exercised under production traffic.

## What it does

- Exposes `POST /v1/chat/completions` and `GET /v1/models`
- Works with clients that can target an OpenAI-compatible base URL
- Supports streaming and non-streaming responses
- Supports OpenAI, Anthropic, Gemini, and generic OpenAI-compatible providers
- Translates text conversations and function/tool calls for Anthropic and Gemini
- Resolves friendly model aliases to ordered provider/model targets
- Retries and falls back only before a response has started
- Emits structured logs without prompts or completions
- Exposes health, readiness, and dependency-free Prometheus metrics
- Runs from TypeScript with Bun or compiles into a standalone executable

TinyRouter has no accounts, billing, credits, database, Redis, dashboard, semantic router, or background control plane.

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

Use `tinyrouter --check --config tinyrouter.yaml` to validate a file. `--print-config` shows the resolved configuration with API keys redacted.

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

## Operations

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `POST /v1/chat/completions` | Configured bearer token | Inference |
| `GET /v1/models` | Configured bearer token | Routes and referenced targets |
| `GET /healthz` | None | Process health |
| `GET /readyz` | None | Configuration readiness |
| `GET /metrics` | None | Prometheus metrics |

`/readyz` verifies that configuration and provider adapters loaded. It deliberately does not send paid health-check requests to providers.

TinyRouter does not terminate TLS. Put it behind a trusted reverse proxy when it is reachable outside a private machine or network. Protect the metrics endpoint separately if operational metadata is sensitive in your environment.

## Build and test

```bash
bun run check
bun test
bun run build
./dist/tinyrouter --version
```

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
