# Contributing

Thanks for helping. freeflow aims to stay small, dependency-free and easy to read.

## Setup

```bash
git clone https://github.com/Ethos6/freeflow && cd freeflow
npm install          # dev tools only: TypeScript and the SDKs used in tests
npm test             # unit and integration tests
npm run test:sdk     # official Anthropic and OpenAI SDKs against freeflow
npm run typecheck
npm run test:e2e     # needs the claude CLI: npm install -g @anthropic-ai/claude-code
```

Run your branch with `node bin/freeflow.js start`.

## Adding a provider

1. Add one entry to `src/catalog.js`: id, name, tier, base URL, key variable, key page and an example model.
2. If the provider needs special handling, prefer an existing `quirks` flag over new code.
3. Run `npm run docs` to regenerate `docs/providers.md`.
4. Mention in the pull request how you verified the base URL (a link to the provider's docs is enough).

Only add providers whose terms allow this kind of use. freeflow uses one key per provider and must never rotate keys or accounts to get around limits.

## Pull requests

- Keep runtime dependencies at zero.
- Add a test for every behaviour change; translation bugs should come with the chunk sequence that triggered them.
- `main` is protected: changes land through pull requests with passing CI.
