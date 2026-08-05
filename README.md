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

TinyRouter has no accounts, billing, credits, database, Redis, semantic router, or background control plane. The gateway serves no dashboard either — the optional status page in [`ui/`](ui/README.md) is a static file that reads the same public endpoints anyone else could, compiled into nothing and imported by nothing.

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

The image sets `TINYROUTER_HOST=0.0.0.0` for itself, because a process listening on loopback inside a container never receives a published port. The shipped example config reads that variable, so a mounted copy of it works either way; a config that hardcodes `127.0.0.1` will not.

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

## Documentation

Full reference lives in [`docs/`](docs/), so it ships in the clone and the tarball and always matches the version you have. [tinyrouter.dev](https://tinyrouter.dev) is the same material for reading online.

| Page | What is in it |
| --- | --- |
| [Configuration](docs/configuration.md) | Every key, plus circuit breaking, request filters, and finding model IDs |
| [Routing contract](docs/routing.md) | What TinyRouter does per request, and what each provider adapter translates |
| [Operations](docs/operations.md) | Endpoints, metrics, the status page, shutdown, TLS |
| [Development](docs/development.md) | Build, test, smoke against live providers, releasing |

The status page in [`ui/`](ui/README.md) is a single static HTML file that reads those endpoints and shows provider health, circuit state, token counts and route order.

## Deliberate omissions

The first release does not implement the Responses API, embeddings, image generation, audio, persistent usage accounting, pricing, budgets, rate limits, caching, a web UI, or multi-user administration.

These are product layers, not prerequisites for a reliable tiny gateway. Additions should preserve the ability to understand the complete routing path without running external infrastructure.

## License

Apache-2.0
