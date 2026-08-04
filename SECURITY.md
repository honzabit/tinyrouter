# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Contact the repository maintainer privately using the security contact published with the repository.

## Security boundaries

- TinyRouter handles provider credentials and may process sensitive prompts.
- Request and response bodies are not logged by the built-in logger.
- Configuration secrets should be supplied through environment variables.
- TinyRouter does not terminate TLS; deployments exposed beyond a trusted network need a TLS reverse proxy.
- `/healthz`, `/readyz`, and `/metrics` are unauthenticated operational endpoints.
- Provider responses are not a trusted input. Keep the gateway and Bun runtime updated.

No claim of production hardening is made for the v0.1 alpha release.
