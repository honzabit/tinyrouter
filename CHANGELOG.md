# Changelog

Notable changes per release. Versions follow semantic versioning with the 0.x caveat that **minor bumps carry the breaking changes**; patches are fixes. Dates are UTC.

## 0.9.0 — Unreleased

### Added

- Two `anthropic` provider options for models that reject what the adapter forwards. Without them, each rejection is an upstream `400`, which ends routing even when a later target could serve the request.
  - `sampling_parameters: drop` leaves out `temperature` and `top_p`. Claude Opus 4.7 and later and the Claude 5 generation reject non-default values. On API version `2026-10-21`, every model rejects any value. Like `seed`, these are best-effort hints, so the target is still used.
  - `forced_tool_choice: skip` skips the provider's targets for `tool_choice: "required"` or a named function. Claude Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject these. A forced choice is a protected requirement and is never weakened to `auto`. Routing continues to a target that can honor it, or fails with `400 unsupported_parameter` and `error.param: "tool_choice"`.

### Unchanged

- Both options default to `forward`, the existing behavior, because models that honor these parameters still need them. TinyRouter still keeps no model catalog: the operator states which providers serve such models, and an account serving both kinds can be configured as two providers with the same key.

## 0.8.0 — 2026-09-27

### Breaking

- Native adapters no longer silently discard protected output requirements. Anthropic is skipped for JSON response formats and strict tool schemas. Gemini is skipped for explicit strict JSON schemas, strict tool schemas, and `parallel_tool_calls: false` when tools are enabled. Routes that previously succeeded only by dropping these constraints now select a later compatible target or return `400 unsupported_parameter`. This routing-contract change belongs in a minor release.

### Added

- Capability errors identify the unsupported field in `error.param`. Attempt logs include `errorCode` and `parameter` alongside the existing `unsupported` outcome, without recording parameter values or request bodies.
- Regression coverage for constrained fallback, preserved outgoing payloads, unsupported-target skips, upstream error precedence, circuit/metric isolation, direct targets, cancellation, and no replay after a selected stream fails.

### Unchanged

- OpenAI and generic OpenAI-compatible requests remain passthrough. Gemini's existing non-strict JSON translation and Anthropic's serial-tool translation are retained. Capability skips do not trigger retries or count as provider failures; real upstream errors retain the existing retry policy. No provider capability catalog, new dependency, configuration option, or response validator is introduced.

## 0.7.0 — 2026-08-05

### Changed

- A target that cannot represent the request's content is now **skipped rather than failing the request**. Previously a route such as `[gemini/…, openai/…]` given an `https` image URL died at translation with `400 unsupported_content` and never contacted a provider, even though a later target would have accepted it. This is the rule filters already followed — a target that may not receive the content says nothing about the targets after it — now applied to content translation as well. The request still fails with `unsupported_content` when no target can represent it, and a real failure from a target that was actually tried is still reported ahead of it.
- Attempt logs gained an `unsupported` outcome, distinct from `blocked`, so a capability skip is not mistaken for a filter rejection.

## 0.6.1 — 2026-08-05

### Added

- `tinyrouter.example.yaml` ships inside each release archive and as a standalone asset. The executable cannot start without a configuration, and the schema gains keys between versions, so the example now travels with the binary that understands it. Named `.example.` so extracting cannot overwrite a real configuration.

## 0.6.0 — 2026-08-05

### Added

- `server.api_keys` names several callers, so one can be revoked by deleting a line rather than rotating a secret everyone shares. The matching key's name appears in the request log as `client`. Additive: `server.api_key` is unchanged.

### Changed

- Keys are compared as SHA-256 digests, so the time a rejection takes discloses neither the length of the presented key nor how many configured keys resemble it.
- A refused request is now logged at warn with its request id and counted as a `401`. It previously produced no log line and no metric at all.
- Loading rejects two names sharing one secret, which would have made revoking either revoke neither.
- Documentation moved to [`docs/`](docs/) and [tinyrouter.dev](https://tinyrouter.dev); the README is the pitch, install, and quickstart.

## 0.5.0 — 2026-08-05

### Breaking

- **`server.host` now defaults to `127.0.0.1`** instead of `0.0.0.0`. A gateway that omits `host` is no longer reachable from other machines. Set it explicitly to serve them. The container image sets `TINYROUTER_HOST=0.0.0.0` for itself, and the environment fills a blank host, so containers are unaffected.

### Added

- `tinyrouter_circuit_open{provider}` and `circuit_breaker` state on `/readyz`, so a demoted provider is visible rather than silently reordering routing.
- `server.allow_origin` shares the observability endpoints with named browser origins. Exact origins only; `/v1/chat/completions` is never shared.
- `server.protect_observability` puts `/readyz` and `/metrics` behind the gateway key. `/healthz` is never gated.
- A single-file status page in [`ui/`](ui/README.md), also attached to each release as `tinyrouter-ui.html`.

### Changed

- Loading rejects an `idle_timeout_seconds` that would preempt `body_timeout_ms`, which silently disabled the `408` response.

## 0.4.0 — 2026-08-05

### Added

- `tinyrouter_tokens_total{provider,model,kind}` reports the tokens providers state, so spend can be attributed per model without a database. Streaming requests only carry usage when the client sets `stream_options.include_usage`.
- `tinyrouter_response_bodies_total{provider,model,outcome}` records how each body ended — a provider that answers `200` and then hangs is invisible in every status counter.
- Opt-in circuit breaking via `routing.circuit_breaker`. A provider that keeps failing is demoted to a last resort rather than costing every request its full timeout. Off by default.
- `server.body_timeout_ms` bounds the gap between request-body chunks.

### Changed

- A client that disconnects ends the request with `499 client_closed_request` and is never counted against a provider, whether it leaves while its body is arriving, while a provider answers, or during a retry wait.
- Provider health is judged by the response delivered rather than by prompt headers.

## 0.3.1 — 2026-08-05

### Changed

- A provider that returns headers and then stalls is cut loose instead of holding the connection open. `timeout_ms` now bounds each gap between body chunks, not just the wait for headers.

## 0.3.0 — 2026-08-05

### Added

- Deterministic request filters. `block` refuses a request naming the rule, `redact` replaces matches with a marker. Scopeable per provider, so local targets can stay unfiltered while cloud ones do not.

## 0.2.0 — 2026-08-04

### Added

- Retries of the same target wait: the provider's `Retry-After` when sent, otherwise a jittered exponential delay bounded by `backoff_max_ms`. Falling back to a different target stays immediate.

## 0.1.2 — 2026-08-04

### Added

- Multi-architecture container images published to GHCR.

### Fixed

- Release executables ship as compressed archives, so macOS does not report a download as damaged.
- Provider rate limits during smoke checks are reported as skipped rather than failed.

## 0.1.1 — 2026-08-04

### Changed

- Releases are gated on live smoke checks, and `package.json` is the single source of the version.

## 0.1.0 — 2026-08-04

First release. OpenAI-compatible gateway with deterministic ordered fallback across OpenAI, Anthropic, Gemini, and generic OpenAI-compatible providers.
