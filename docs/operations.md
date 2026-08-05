# Operations

[← TinyRouter](../README.md) · [Configuration](configuration.md) · [Routing](routing.md) · [Operations](operations.md) · [Development](development.md)

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `POST /v1/chat/completions` | Configured bearer token | Inference |
| `GET /v1/models` | Configured bearer token | Routes and referenced targets |
| `GET /healthz` | None | Process health |
| `GET /readyz` | None, or `api_key` | Configuration readiness |
| `GET /metrics` | None, or `api_key` | Prometheus metrics |

`/readyz` and `/metrics` are open by default, which is the usual arrangement for a scrape target and for container probes. They are not nothing, though: together they disclose which providers you use, which models, roughly what you spend, and which provider is failing right now. `server.host` therefore defaults to `127.0.0.1`, so a fresh install is not reachable from the network until you say it should be, and `server.protect_observability: true` puts `/readyz` and `/metrics` behind `api_key` for deployments that do listen more widely. Prometheus sends the key with `authorization` in its scrape config. `/healthz` is never gated — it reports only that the process is alive, and a probe cannot carry a credential.

`/readyz` verifies that configuration and provider adapters loaded. It deliberately does not send paid health-check requests to providers.

`/metrics` reports request and attempt counters, plus `tinyrouter_tokens_total{provider,model,kind}` for the tokens providers report, so spend can be attributed per model without a database. Tokens are counted as the response passes through, never by altering it.

`tinyrouter_response_bodies_total{provider,model,outcome}` records how each response body ended — `completed`, `stalled`, `failed`, or `cancelled`. The status line is sent before any of that is known, so a provider that answers `200` and then hangs looks healthy in the request and attempt counters; this is where that shows up, and it is the same signal the circuit breaker acts on.

`ui/` holds a single-file status page that reads these endpoints and shows provider health, circuit state, token counts and route order. It is a static HTML file with no build step and no dependencies, compiled into nothing and imported by nothing — see [ui/README.md](../ui/README.md). It needs `server.allow_origin` set, and no API key for anything but the route list.

`tinyrouter_circuit_open{provider}` is `1` while the breaker has a provider demoted and `0` otherwise, read from the breaker at scrape time rather than stored — a circuit closes when its cooldown elapses, not on an event. Every configured provider gets a series, since an absent one is indistinguishable from a scrape that never happened. `/readyz` carries the same state as `circuit_breaker: { enabled, open: [...] }` for a quick look without a scraper. Readiness itself stays `ready` while a provider is cooling: demoted is not removed, the gateway still serves, and flipping it would pull the process out of rotation over something that is not an outage.

Completions always report usage. **A streaming request reports usage only when the client sets `stream_options.include_usage`** — without that flag the provider never sends the numbers, so there is nothing to count. TinyRouter reports what it observes rather than estimating, so enable that flag in your client if you want streaming traffic to appear in the token counters. Counts that are not whole non-negative numbers are discarded rather than recorded, and a client that disconnects mid-stream still has whatever the provider already generated counted against it.

TinyRouter logs a warning at startup when `server.api_key` is unset and the host is not loopback — that combination leaves `/v1` endpoints open to anyone who can reach the address. On SIGINT or SIGTERM it drains in-flight requests, including active streams, for up to ten seconds before closing the remaining connections.

TinyRouter does not terminate TLS. Put it behind a trusted reverse proxy when it is reachable outside a private machine or network. Protect the metrics endpoint separately if operational metadata is sensitive in your environment.
