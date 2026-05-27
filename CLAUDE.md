# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **pnpm workspace** of OpenCode plugins under the `@vymalo` npm scope. There are two runtime plugins plus a Rolldown-based bundler — both plugins target OpenCode's plugin API (`@opencode-ai/plugin`) and ship to npm independently.

| Package | Purpose |
| --- | --- |
| `packages/opencode-oauth2` → `@vymalo/opencode-oauth2` | OAuth2 / OIDC auth + dynamic model discovery for OpenAI-compatible providers. The mature plugin; five auth flows, persistent token cache, periodic sync scheduler. |
| `packages/opencode-models-info` → `@vymalo/opencode-models-info` | **Auth-agnostic** metadata enrichment plugin: fetches OpenRouter-shaped `/models` JSON and merges `limit` / `cost` / `modalities` / capability flags onto existing provider model entries. Runs as a `Hooks.config` hook *after* other plugins. |
| `packages/plugin-bundle` → `@vymalo/opencode-oauth2-bundle` (private) | Rolldown build that ships a single-file distribution of the oauth2 plugin. |

The two plugins are deliberately decoupled: `opencode-models-info` does not import from `opencode-oauth2` and works with any auth scheme (static API key, oauth2, none) because it only mutates the already-resolved OpenCode config.

## Common commands

```sh
pnpm install                 # bootstrap workspace
pnpm -r build                # compile all packages (tsc → dist/)
pnpm -r typecheck            # tsc --noEmit across packages
pnpm -r test                 # vitest run in each package that has tests
pnpm lint                    # biome lint (full repo)
pnpm format                  # biome format --write
```

Per-package iteration (much faster):

```sh
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
pnpm --filter @vymalo/opencode-models-info typecheck
```

Single-test run inside a package:

```sh
pnpm --filter @vymalo/opencode-oauth2 exec vitest run path/to/file.test.ts
pnpm --filter @vymalo/opencode-oauth2 exec vitest run -t "ensureAccessToken"   # by test name
```

Watch mode: `pnpm --filter <pkg> exec vitest` (no `run`).

### Integration tests (Docker)

A reusable compose stack of HTTP backends lives under [`test-env/`](test-env/). Currently a WireMock service stubs the OpenRouter-shaped `/v1/models` endpoint for `@vymalo/opencode-models-info`; a Keycloak service is sketched-in (commented out) for the upcoming `@vymalo/opencode-oauth2` integration suite.

```sh
pnpm test:env:up               # docker compose up (waits for healthcheck)
pnpm --filter @vymalo/opencode-models-info test:integration
pnpm test:env:down             # docker compose down -v
# or one-shot:
pnpm test:integration          # compose up → all packages' integration suites → compose down
```

Integration tests live under `test/integration/**/*.test.ts`, run via a separate `vitest.integration.config.ts`, and **skip themselves** when `INTEGRATION_MODELS_INFO_URL` is unset — so the default `pnpm test` stays hermetic. Stubs are at [`test-env/wiremock/mappings/`](test-env/wiremock/mappings/) and [`test-env/wiremock/__files/`](test-env/wiremock/__files/); editing them needs either a `wiremock` container restart or `curl -X POST http://127.0.0.1:18080/__admin/mappings/reset`.

## Architecture: how the plugins fit OpenCode

OpenCode plugins implement a `Hooks` object (see `@opencode-ai/plugin`'s `index.d.ts`). The two hooks this repo uses:

- **`Hooks.config(input: SDKConfig)`** — runs once at plugin load, mutates the assembled OpenCode config (`input.provider`, `input.pluginConfig`, etc.). Both plugins use this — oauth2 to **register** managed providers and merge discovered models; models-info to **enrich** whatever providers/models are already there.
- **`Hooks["chat.headers"](input, output)`** — runs per chat request. Only oauth2 uses this; it injects `Authorization: Bearer <token>` for providers it manages.

The whole picture sits in [`docs/architecture.md`](docs/architecture.md). If you're modifying hook behavior, read it first — it documents token lifecycle per flow, cache layout, the TTY-aware warmup logic, and which events you should expect in the log stream.

### Per-package file layout convention

Both plugins follow the same shape:

```
packages/<plugin>/
├── src/
│   ├── index.ts        # OpenCode entry — re-exports default plugin
│   ├── opencode.ts     # Plugin factory: createXxxPlugin(opts) → Plugin
│   ├── lib.ts          # Public library API (exposed via "./lib" subpath in exports)
│   ├── plugin.ts       # Core runtime logic (split from opencode.ts so it stays testable)
│   ├── cache.ts        # FileCacheStore — per-OS cache dir, atomic rename, 0o600
│   ├── logging.ts      # JSON console logger, host log-level mapping, secret redaction
│   └── …
└── test/               # vitest, *.test.ts
```

**Important — two entry points per published package:**

- `"."` resolves to `dist/index.js` and is what OpenCode discovers. The host iterates every named export and rejects anything that isn't a `Plugin` function, so `index.ts` is kept *intentionally tiny* (a single `export { default } from "./opencode.js";`). See [`packages/opencode-oauth2/src/index.ts`](packages/opencode-oauth2/src/index.ts) and the matching `slim main entry` fix in commit history.
- `"./lib"` resolves to `dist/lib.js` and is the library API for embedders. New utility exports go through `lib.ts`, not `index.ts`.

### Composition contract (models-info)

`@vymalo/opencode-models-info` runs after other `config` hooks have populated `input.provider`. It opts in per provider via `options.meta.modelsInfoUrl` and the merge is **upstream-wins**: a field already present on a model entry is never overwritten. This is deliberate — it means the plugin is safe to enable globally and lets handwritten `opencode.json` config take precedence.

When changing the mapping in [`packages/opencode-models-info/src/mapping.ts`](packages/opencode-models-info/src/mapping.ts):

- OpenRouter's `pricing.prompt` / `.completion` are USD-per-token strings; OpenCode's `cost.input` / `cost.output` are USD-per-1M-tokens numbers. The conversion (`* 1_000_000` then round to 6 decimals) lives in `mapping.ts`. Don't move it.
- `limit` only emits if **both** `context` and `output` are known — partial `limit` blocks are invalid in OpenCode's schema.
- Modalities are filtered to OpenCode's enum (`text | audio | image | video | pdf`) — `"file"` and other OpenRouter values are dropped.

## Conventions worth knowing

- **Biome, not ESLint/Prettier.** Config in [`biome.json`](biome.json) — double quotes, 100-col, no trailing commas, semicolons always. `noNonNullAssertion` is a warning the existing code stays clean of; mirror that in new code (`@vymalo/opencode-oauth2` has 0 warnings, treat that as the bar).
- **Strict TS.** Base config is in [`tsconfig.base.json`](tsconfig.base.json) — `ES2022` + `NodeNext` + `strict: true`. Per-package tsconfig only sets `rootDir`/`outDir`. `lib.ts` re-exports are the public surface.
- **Vitest** is the test runner; each package owns a `vitest.config.ts`. Tests live in `test/`, not co-located.
- **Node ≥ 22** for the runtime packages (set in each package.json `engines`). Use `node:` prefixed imports for built-ins (`node:fs/promises`, `node:crypto`).
- **Logging pattern**: every plugin emits structured events through both a JSON console fallback and `client.app.log` (so the host log stream picks them up). Event names use `snake_case` (`models_info_cache_hit`, `oauth2_token_refreshed`). Add new events to that pattern, not ad-hoc `console.log`.
- **Cache layout** mirrors per-OS conventions — `~/Library/Caches/<ns>/` on macOS, `XDG_CACHE_HOME` on Linux, `LOCALAPPDATA` on Windows. Each plugin uses its own namespace (`opencode-oauth2`, `opencode-models-info`). Disk writes are atomic-rename + `0o600`.

## Shell / GitHub gotchas

- **Default shell is zsh** on this laptop. `bash -c` scripts in tooling should stay POSIX-portable or be invoked under zsh explicitly.
- **`gh` auth** lives in the interactive zsh profile. If `gh` looks unauthenticated under a plain non-interactive shell, retry under `zsh -i -c '…'` — `GITHUB_TOKEN` is loaded from `.zshrc`.
- **Biome ignores `**/.claude`** in `biome.json`. The Claude Code worktree path lives under `.claude/worktrees/<id>/`, which means running `pnpm lint` from a worktree silently lints zero files. Lint per-package (`pnpm --filter <pkg> exec biome lint .`) from a worktree, or run the workspace lint from the main checkout.

## Design docs and plans

- [`plans/prd.md`](plans/prd.md) — original oauth2 PRD with the phased roadmap.
- [`plans/models-info-plan.md`](plans/models-info-plan.md) — design doc for the metadata plugin, including the OpenRouter→OpenCode field mapping table.
- [`docs/`](docs/) — architecture, GitHub Actions / Kubernetes cookbooks, local-dev setup, troubleshooting. The architecture doc is canonical for hook behavior.
