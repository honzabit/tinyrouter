# Build and test

[← TinyRouter](../README.md) · [Configuration](configuration.md) · [Routing](routing.md) · [Operations](operations.md) · [Development](development.md)

```bash
bun run check
bun run lint
bun run knip
bun test
bun run build
./dist/tinyrouter --version
```

`check` type-checks, `lint` runs Biome (formatter and linter; `bun run format` rewrites in place), and `knip` reports unused exports and dependencies. CI runs all of them.

# Smoke tests against real providers

Unit tests mock every upstream. `bun run smoke` complements them with live traffic: it starts a real gateway configured with whichever providers have credentials in the environment, then sends a completion, a streamed completion, and a forced tool call through each one.

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... bun run smoke
```

```bash
SMOKE_LOCAL_BASE_URL=http://localhost:11434/v1 SMOKE_LOCAL_MODEL=qwen2.5:0.5b bun run smoke
```

Providers without credentials are skipped, and the models are overridable via `SMOKE_OPENAI_MODEL`, `SMOKE_ANTHROPIC_MODEL`, and `SMOKE_GEMINI_MODEL`. A check the provider rate limits is reported as skipped rather than failed, since a quota says nothing about the gateway; a run where every check was rate limited still fails, because it verified nothing.

The Smoke workflow runs the same script on demand from the Actions tab, and the release workflow runs it as a gate. One job needs no secrets at all: it installs Ollama on the runner, pulls a small CPU model, and routes real inference through the gateway. The other exercises hosted providers using the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` repository secrets — set whichever you want covered. Model IDs can be overridden per repository with `SMOKE_OPENAI_MODEL`, `SMOKE_ANTHROPIC_MODEL`, `SMOKE_GEMINI_MODEL`, and `OLLAMA_MODEL` Actions variables, so a provider retiring a model does not require a code change.

# Releasing

Versions follow semantic versioning, with the caveat that 0.x minor bumps carry the breaking changes. Bump the minor for anything that changes the configuration schema, the routing contract, or an endpoint's shape; bump the patch for fixes.

`package.json` is the only place the version lives — `--version` and `GET /` both read it — so a release is a version bump, a tag, and a push:

```bash
bun run release 0.2.0
```

That script rewrites `package.json`, commits, and creates the annotated tag; pushing it starts the release workflow:

```bash
git push origin main --follow-tags
```

The workflow re-runs the full suite, gates on the live smoke checks, then builds the four archives and publishes the release with a generated changelog. A tag whose name disagrees with `package.json` fails before anything is published, and nothing is released if smoke fails. The workflow can also be dispatched manually with an existing tag to rebuild and attach its executables.

The compiled executable embeds the Bun runtime. It is operationally standalone, although larger than an equivalent Go executable.

Build the container locally, as CI does on every push, rather than pulling the published image:

```bash
docker build -t tinyrouter .
docker run --rm -p 8080:8080 \
  --env-file .env \
  -v "$PWD/tinyrouter.yaml:/etc/tinyrouter/tinyrouter.yaml:ro" \
  tinyrouter
```
