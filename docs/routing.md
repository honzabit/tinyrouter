# Routing contract

[← TinyRouter](../README.md) · [Configuration](configuration.md) · [Routing](routing.md) · [Operations](operations.md) · [Development](development.md)

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

# Providers

| Type | Request behavior | Response behavior |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions passthrough | Passthrough |
| `openai-compatible` | Configurable OpenAI-shaped endpoint | Passthrough |
| `anthropic` | Translates messages, tools, and common generation options | Normalizes JSON and SSE |
| `gemini` | Translates messages, tools, common options, and JSON response format | Normalizes JSON and SSE |

The generic OpenAI-compatible adapter passes unknown request fields through unchanged. Native adapters intentionally support a smaller common subset; provider-specific features that have no safe cross-provider representation are not silently invented.

Images are translated for both native adapters: Anthropic accepts http(s) URLs and base64 `data:` URIs, Gemini accepts base64 `data:` URIs. Content parts that have no representation for the selected provider are rejected with a 400 `unsupported_content` error rather than silently dropped, so clients never talk to a silently blind model.
