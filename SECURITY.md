# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Reports are acknowledged on a best-effort basis; this is a volunteer-maintained project.

## Security boundaries

- TinyRouter handles provider credentials and may process sensitive prompts.
- Request and response bodies are not logged by the built-in logger.
- Configuration secrets should be supplied through environment variables.
- TinyRouter does not terminate TLS; deployments exposed beyond a trusted network need a TLS reverse proxy.
- Inbound requests to `/v1` are authenticated with a bearer token: either `server.api_key`, a single shared secret, or `server.api_keys`, a map of name to secret so one caller can be revoked without rotating the others. Keys are compared as SHA-256 digests, so the time a rejection takes discloses neither the length of the presented key nor how many configured keys resemble it. Revoking means editing the file and restarting; there is no runtime issuance, and no per-caller budget or quota. A refused request is logged at warn with its request id, never with the credential.
- `/healthz` is unauthenticated and reports only that the process is alive.
- `/readyz` and `/metrics` are unauthenticated by default and disclose configured provider and model names, request and token volumes, and which providers the circuit breaker has demoted. They carry no prompts, completions, or credentials. `server.host` defaults to `127.0.0.1` so this is not reachable off the machine unless you widen it; `server.protect_observability: true` puts both behind the gateway key when you do.
- Provider responses are not a trusted input. Keep the gateway and Bun runtime updated.

No claim of production hardening is made for the v0.1 alpha release.
