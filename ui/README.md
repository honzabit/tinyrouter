# TinyRouter status page

One HTML file, no build step, no dependencies, no server of its own. It answers the question the gateway's endpoints can report but not show: **which providers are healthy right now, and which has the circuit breaker demoted?**

It lives here rather than inside the gateway because it is not part of it. Nothing here is compiled into the executable, imported by `src/`, or run in the request path. It reads three public HTTP endpoints and could as easily be someone else's page. "No dashboard in the gateway" stays true.

## Use it

Serve this directory and open it:

```bash
python3 -m http.server 5173 --directory ui
```

Then tell the gateway to share with wherever you opened it, in `tinyrouter.yaml`:

```yaml
server:
  allow_origin: ["http://localhost:5173"]
```

Restart the gateway. Without that line the browser refuses to let the page read anything, and the page says so with the line you need.

## The API key is optional

`/readyz` and `/metrics` are unauthenticated by default, so provider health, traffic, token counts and circuit state all work with no credential. A key is needed to list route aliases, which comes from `/v1/models`, and for everything else too if the gateway sets `server.protect_observability`. When one is entered it is sent to every request, so either arrangement works.

When you enter one it is kept in `sessionStorage`, so closing the tab discards it rather than leaving a credential behind on a shared machine. The gateway address is kept in `localStorage`, since it is not a secret.

## What it shows

- **Gateway** — readiness, uptime, requests in flight, totals, how many providers are cooling
- **Providers** — circuit state per provider, models seen, attempts split by success and error, bad body outcomes
- **Tokens** — prompt and completion counts per provider and model, as the provider reported them
- **Routes** — each alias and the order its targets are tried in

"Bad bodies" is the column worth knowing about. TinyRouter counts how each response body *ended*, after its status line was already sent. A provider that answers `200` and then hangs looks perfectly healthy in any request or attempt counter; it shows up here as a stalled body, and it is the same signal the circuit breaker acts on.

When the gateway cannot be read, the page dims everything it last knew and says how old it is. A status page whose stale numbers still read "ready" is worse than one showing nothing.

## Notes for anyone changing it

Provider and model names reach `/metrics` from request bodies — a client picks the `model` string, and the gateway validates it against control characters but not against markup. Everything rendered here is therefore attacker-influenced text. The page builds DOM nodes and assigns `textContent`; there is no `innerHTML` anywhere, and there should not be.

`bun run lint` covers this file. Biome lints the inline script, so it is held to the same rules as the gateway.
