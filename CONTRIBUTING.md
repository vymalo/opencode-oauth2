# Contributing

Thanks for helping out! This is a [pnpm](https://pnpm.io) workspace of OpenCode plugins (the
`@vymalo` scope) plus a companion browser extension. This guide gets you from clone to PR.

## Prerequisites

- **Node ≥ 22** (runtime packages set this in `engines`).
- **pnpm 11** (`packageManager` pins the exact version).
- For the browser extension: a Chromium browser and/or Firefox to load it unpacked.

## Bootstrap

```sh
pnpm install            # install the whole workspace
pnpm -r build           # compile every package (tsc → dist/, wxt build for the extension)
pnpm -r test            # vitest in each package that has tests
```

## The pre-push gate

Run all five before opening a PR — CI runs the same:

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check
```

> **Order matters.** `@vymalo/opencode-browser-mcp` typechecks against
> `@vymalo/opencode-browser`'s built `./lib` export, so **build before typecheck/test** (CI does).

## Per-package iteration (faster)

```sh
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
pnpm --filter @vymalo/opencode-oauth2 exec vitest run path/to/file.test.ts
pnpm --filter @vymalo/opencode-oauth2 exec vitest run -t "ensureAccessToken"   # by name
pnpm --filter @vymalo/opencode-oauth2 exec vitest                              # watch mode
```

## Integration tests (Docker)

A reusable compose stack lives in [`test-env/`](test-env/). Integration suites **skip
themselves** when their env var is unset, so the default `pnpm test` stays hermetic.

```sh
pnpm test:env:up                                            # compose up (waits for health)
pnpm --filter @vymalo/opencode-models-info test:integration
pnpm test:env:down
# or one-shot:
pnpm test:integration
```

## Conventions

- **Biome, not ESLint/Prettier.** Config in [`biome.json`](biome.json): double quotes, 100-col,
  no trailing commas, semicolons always. Keep **0 lint warnings** — `noNonNullAssertion` is a
  warning the codebase stays clean of; don't introduce `!`.
- **Strict TypeScript** (`tsconfig.base.json`: `ES2022` + `NodeNext` + `strict`). Use `node:`
  prefixes for built-ins.
- **kebab-case filenames** for `.ts/.tsx/.css/.md/.json/.sh`; `camelCase` vars/functions;
  `PascalCase` types/components; `SCREAMING_SNAKE_CASE` true constants.
- **Tests** live in `test/`, not co-located. Vitest everywhere.
- **Structured logging** — emit `snake_case` events through the existing logger (console + host
  log stream), never ad-hoc `console.log`. Redact secrets.
- **Lint/format scripts pass explicit paths** (`packages apps test-env *.json`) because
  `biome.json` excludes `**/.claude`; if you add a top-level lintable dir, add it to those
  scripts.

## Package layout

Each plugin follows the same shape:

```
packages/<plugin>/src/
├── index.ts      # tiny re-export — OpenCode discovers this (rejects non-Plugin exports)
├── opencode.ts   # plugin factory + default export
├── plugin.ts     # core runtime (split out so it stays testable)
├── lib.ts        # public library API (the "./lib" export subpath)
└── …
```

Two entry points per published package: `"."` → `dist/index.js` (kept intentionally tiny);
`"./lib"` → `dist/lib.js` (the embedder API — new utilities go here, not in `index.ts`).

## Commit & PR

- Conventional-commit style subjects (`feat(browser): …`, `fix(oauth2): …`, `docs: …`).
- Keep one concern per PR; open an issue first for substantial changes so we can align on scope.
- Make sure the pre-push gate is green and docs are updated alongside behavior changes.

## Releasing (maintainers)

Versions are bumped **manually** — no changesets. The five published packages
(`opencode-oauth2`, `opencode-models-info`, `opencode-ratelimit`, `opencode-browser`,
`opencode-browser-mcp`) plus the three private ones (workspace root, `plugin-bundle`,
`browser-extension`) are all kept on **one version line** and bumped together in a single PR.
After it merges, a maintainer publishes:

1. Tag the commit and publish a GitHub Release → `publish.yml` runs the gate, `npm publish`es the
   five packages (with provenance), attaches the extension zips to the Release, and `wxt submit`s
   to the Chrome Web Store + Firefox AMO (each gated on its store secrets).
2. A `workflow_dispatch` with `dry_run: true` validates everything (incl. store creds via
   `wxt submit --dry-run`) **without** publishing.

See the [Releasing section in CLAUDE.md](CLAUDE.md#releasing) for the full mechanics.

## Where to read next

- [`docs/README.md`](docs/README.md) — the documentation index.
- [`CLAUDE.md`](CLAUDE.md) — the live architectural map of the repo.
