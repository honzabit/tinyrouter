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
| `n` other than 1 | Passed through | Target skipped | Target skipped |
| `logprobs: true` | Passed through | Target skipped | Target skipped |
| `top_logprobs` set | Passed through | Target skipped | Target skipped |
| `reasoning_effort: "low"`, `"medium"`, `"high"` | Passed through | Translated to `thinking: {type: "adaptive"}` and `output_config.effort` | Translated to `generationConfig.thinkingConfig.thinkingLevel` |
| `reasoning_effort: "xhigh"`, `"max"` | Passed through | Translated to `thinking: {type: "adaptive"}` and `output_config.effort` | Target skipped |
| `reasoning_effort: "minimal"` | Passed through | Target skipped | Translated to `generationConfig.thinkingConfig.thinkingLevel` |
| `reasoning_effort: "none"` or any other value | Passed through | Target skipped | Target skipped |
| `seed` (best-effort hint, not protected) | Passed through | Dropped | Dropped |

Omitted/null response formats and `{type: "text"}` remain ordinary text requests. Omitted/null/false strict flags retain the existing non-strict behavior. With no tools, an empty tool list, or `tool_choice: "none"`, there are no calls to parallelize, so `parallel_tool_calls: false` does not disqualify Gemini. A true or omitted/null parallel setting likewise imposes no serial-call constraint.

Unknown or malformed response-format variants, non-boolean strict flags, and non-boolean parallel settings are not silently discarded by native adapters; those targets are skipped. The same holds for an `n` that is not 1, a `logprobs` that is not a boolean, and a `reasoning_effort` that is not one of the listed strings. A Gemini `json_schema` request must contain an object at `response_format.json_schema.schema`. Passthrough adapters continue forwarding fields unchanged, leaving provider-specific validation and enforcement to the upstream.

`n` above 1 and log probabilities change the shape of the response, and neither native translation can return extra choices or token log probabilities. `n: 1`, `logprobs: false`, and omitted/null values are ordinary requests. TinyRouter deliberately does not translate `n` to Gemini's `candidateCount`: Gemini 3 and later models reject `candidateCount` above 1 with an upstream error that would end routing instead of falling back, and the streaming translation carries only one candidate.

`reasoning_effort` is translated only to a provider level of the same name; a nearby level would silently change how much the model reasons, so the target is skipped instead. Anthropic receives `thinking: {type: "adaptive"}`, which turns thinking on for models that default it off, together with `output_config.effort`. Gemini receives `generationConfig.thinkingConfig.thinkingLevel`. Whether a given model offers a level is still the provider's decision, not a TinyRouter catalog. Earlier generations without these controls (Claude 4.5 and older models, Gemini 2.5 models), and models that lack a particular level, reject the request with an upstream `400`. That ends routing like any other upstream request error. Thinking output is not surfaced: Anthropic thinking blocks are removed from normalized responses and streams, and Gemini thought summaries are not requested. Chat Completions messages have no place for thinking blocks, so they are not sent back on later turns either.

Anthropic counts thinking tokens toward `max_tokens`. Claude Sonnet 4.6 and Opus 4.6–4.8 do not think unless asked, so on those models a request with `reasoning_effort` now spends part of its output limit on thinking. A request without `max_tokens` or `max_completion_tokens` gets the provider's `default_max_tokens`, which is 4096 unless configured. At `high` effort and above, that can end with `finish_reason: "length"` and little or no text. Clients that send `reasoning_effort` should send a larger `max_tokens`, or operators should raise `default_max_tokens` on the Anthropic provider.

`seed` is a best-effort determinism hint even where it is supported, so it is not a protected requirement: both native adapters drop it and the target is still used.

If no target can preserve a protected requirement, the gateway returns `400` with `error.code: "unsupported_parameter"` and an `error.param` such as `response_format`, `n`, `reasoning_effort`, or `tools[0].function.strict`. Each skipped attempt records `outcome: "unsupported"`, `errorCode`, and `parameter`, without logging the prompt, schema, or parameter value. When different targets are excluded for different reasons, the last local exclusion supplies the final error; a real failure from a target actually contacted still takes precedence.

This is a bounded compatibility contract, not complete API equivalence or response-schema validation. Gemini's existing non-strict schema translation is retained; it is not treated as implementing OpenAI's explicit strict contract. Other provider-specific options retain their existing behavior. A passthrough endpoint accepting a request is not a guarantee that its model supports every requested feature.

# Providers

| Type | Request behavior | Response behavior |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions passthrough | Passthrough |
| `openai-compatible` | Configurable OpenAI-shaped endpoint | Passthrough |
| `anthropic` | Translates messages, tools, common generation options, and reasoning effort | Normalizes JSON and SSE |
| `gemini` | Translates messages, tools, common options, reasoning effort, and non-strict JSON response format | Normalizes JSON and SSE |

The generic OpenAI-compatible adapter passes unknown request fields through unchanged. Native adapters intentionally support a smaller common subset; provider-specific features that have no safe cross-provider representation are not silently invented. The protected requirements above are checked explicitly before translation.

Images are translated for both native adapters: Anthropic accepts http(s) URLs and base64 `data:` URIs, Gemini accepts base64 `data:` URIs. Content parts that have no representation for the selected provider cause that target to be skipped rather than silently dropped, so clients never talk to a silently blind model.
