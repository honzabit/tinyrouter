# Contributing

TinyRouter values a small, legible core over a large feature matrix.

Before opening a change:

1. Explain the failure mode or user need it addresses.
2. Keep provider-specific behavior inside its adapter.
3. Never log prompts, completions, provider keys, or inbound bearer tokens.
4. Add tests for request translation, response normalization, and streaming when applicable.
5. Run `bun run check`, `bun run lint`, `bun run knip`, and `bun test`.

New dependencies should remove more complexity than they introduce. Features requiring persistent infrastructure should normally live outside the core process.
