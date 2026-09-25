# Routing contract

[← TinyRouter](../README.md) · [Configuration](configuration.md) · [Routing](routing.md) · [Operations](operations.md) · [Development](development.md)

A request can name either an alias such as `smart` or a direct target such as `anthropic/claude-sonnet-4-6`.

For each request TinyRouter:

1. Resolves the alias to its ordered targets.
2. Calls the first target whose filters and adapter can represent the request.
3. Retries it only when the status is configured in `retry_statuses` or the connection fails.
4. Waits between retries of the same target — the provider's `Retry-After` when sent, a jittered exponential delay otherwise, never longer than `backoff_max_ms`.
5. Moves to the next target only for those same retryable failures, without waiting.
6. Stops immediately on authentication and ordinary upstream request errors.
7. Commits to a provider as soon as that provider returns a successful response.

A target that cannot represent the request's content — an image in a form the provider does not accept, for instance — is skipped, and routing continues to the next one. That is the same rule a firing filter block follows: a target that may not receive the content says nothing about the targets after it. The request fails with `400 unsupported_content` only when no target can represent it, and a real failure from a target that was actually tried is reported ahead of it. Skipped targets appear in the attempt log with outcome `unsupported`, distinct from a filter's `blocked`.

The same preflight rule applies to the protected output requirements below: an adapter that would discard a requirement is skipped **before any upstream request**, rather than silently weakening the request. Capability skips are not retried, do not count as upstream attempts, and neither trip nor clear a provider's circuit breaker. Actual upstream HTTP errors still follow the retry policy above; they are not reclassified as capability skips.

TinyRouter never switches providers after a stream has begun. Mid-stream errors remain stream errors; replaying the request against another model could duplicate output or tool calls.

The response includes:

- `x-request-id`
- `x-tinyrouter-provider`
- `x-tinyrouter-model`

Structured logs record target attempts, status, latency, and routing outcome. They do not record request or response bodies.

## Protected output requirements

These checks describe the translations **implemented by TinyRouter**, not everything the providers or their individual models support. They apply equally to aliases, direct targets, streaming, and non-streaming requests.

| Requirement | OpenAI / OpenAI-compatible | Anthropic adapter | Gemini adapter |
| --- | --- | --- | --- |
| `response_format: {type: "json_object"}` | Passed through | Target skipped | Existing JSON MIME-type translation |
| `response_format: {type: "json_schema", ...}` without explicit strict mode | Passed through | Target skipped | Existing schema and JSON MIME-type translation |
| `response_format.json_schema.strict: true` | Passed through | Target skipped | Target skipped |
| `tools[].function.strict: true` | Passed through | Target skipped | Target skipped |
| `parallel_tool_calls: false` with tools enabled | Passed through | Translated to `disable_parallel_tool_use: true` | Target skipped |

Omitted/null response formats and `{type: "text"}` remain ordinary text requests. Omitted/null/false strict flags retain the existing non-strict behavior. With no tools, an empty tool list, or `tool_choice: "none"`, there are no calls to parallelize, so `parallel_tool_calls: false` does not disqualify Gemini. A true or omitted/null parallel setting likewise imposes no serial-call constraint.

Unknown or malformed response-format variants, non-boolean strict flags, and non-boolean parallel settings are not silently discarded by native adapters; those targets are skipped. A Gemini `json_schema` request must contain an object at `response_format.json_schema.schema`. Passthrough adapters continue forwarding fields unchanged, leaving provider-specific validation and enforcement to the upstream.

If no target can preserve a protected requirement, the gateway returns `400` with `error.code: "unsupported_parameter"` and an `error.param` such as `response_format` or `tools[0].function.strict`. Each skipped attempt records `outcome: "unsupported"`, `errorCode`, and `parameter`, without logging the prompt, schema, or parameter value. When different targets are excluded for different reasons, the last local exclusion supplies the final error; a real failure from a target actually contacted still takes precedence.

This is a bounded compatibility contract, not complete API equivalence or response-schema validation. Gemini's existing non-strict schema translation is retained; it is not treated as implementing OpenAI's explicit strict contract. Other provider-specific options retain their existing behavior. A passthrough endpoint accepting a request is not a guarantee that its model supports every requested feature.

# Providers

| Type | Request behavior | Response behavior |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions passthrough | Passthrough |
| `openai-compatible` | Configurable OpenAI-shaped endpoint | Passthrough |
| `anthropic` | Translates messages, tools, and common generation options | Normalizes JSON and SSE |
| `gemini` | Translates messages, tools, common options, and non-strict JSON response format | Normalizes JSON and SSE |

The generic OpenAI-compatible adapter passes unknown request fields through unchanged. Native adapters intentionally support a smaller common subset; provider-specific features that have no safe cross-provider representation are not silently invented. The protected requirements above are checked explicitly before translation.

Images are translated for both native adapters: Anthropic accepts http(s) URLs and base64 `data:` URIs, Gemini accepts base64 `data:` URIs. Content parts that have no representation for the selected provider cause that target to be skipped rather than silently dropped, so clients never talk to a silently blind model.
