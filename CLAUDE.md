# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **pnpm workspace** of OpenCode plugins under the `@vymalo` npm scope. There are three runtime plugins plus a Rolldown-based bundler — all plugins target OpenCode's plugin API (`@opencode-ai/plugin`) and ship to npm independently.

| Package | Purpose |
| --- | --- |
| `packages/opencode-oauth2` → `@vymalo/opencode-oauth2` | OAuth2 / OIDC auth + dynamic model discovery for OpenAI-compatible providers. The mature plugin; five auth flows (`authorization_code`, `device_code`, `client_credentials`, `jwt_bearer`, `token_exchange`), persistent token cache, periodic sync scheduler. PKCE is on by default for the two interactive flows (`pkce: false` opts out per server). |
| `packages/opencode-models-info` → `@vymalo/opencode-models-info` | **Auth-agnostic** metadata enrichment plugin: fetches OpenRouter-shaped `/models` JSON and merges `limit` / `cost` / `modalities` / capability flags onto existing provider model entries. Runs as a `Hooks.config` hook *after* other plugins. |
| `packages/opencode-ratelimit` → `@vymalo/opencode-ratelimit` | **Auth-agnostic** rate-limit awareness plugin: in its `Hooks.config` hook it injects a custom `fetch` onto opted-in providers (`options.meta.rateLimit`) that reads Envoy Gateway / IETF draft-03 rate-limit headers (`x-ratelimit-limit/remaining/reset`), proactively throttles when `remaining` hits 0, and backs off + retries on `429`. Supports `tiers` (reset-magnitude policy bands with `wait`/`error` actions, so a 60s burst waits but a multi-day budget reset errors fast) and `scope: "model"\|"provider"` (per-model cooldown buckets for per-model gateway limits). The only response-observing plugin — OpenCode has no post-response hook, so wrapping `options.fetch` is the sole interception point. In-memory state only (no `cache.ts`). See [`docs/ratelimit.md`](docs/ratelimit.md). |
| `packages/plugin-bundle` → `@vymalo/opencode-oauth2-bundle` (private) | Rolldown build that ships a single-file distribution of the oauth2 plugin. |

The plugins are deliberately decoupled: `opencode-models-info` and `opencode-ratelimit` do not import from `opencode-oauth2` (or each other) and work with any auth scheme (static API key, oauth2, none) because they only mutate the already-resolved OpenCode config. Soft ordering recommendation when stacking them in `plugin`: oauth2 → models-info → ratelimit (config hooks run in registration order; ratelimit's fetch wrapping is auth-independent so its position is cosmetic, but models-info genuinely needs the oauth2 bearer first — see the composition contract below).

## Common commands

```sh
pnpm install                 # bootstrap workspace
pnpm -r build                # compile all packages (tsc → dist/)
pnpm -r typecheck            # tsc --noEmit across packages
pnpm -r test                 # vitest run in each package that has tests
pnpm lint                    # biome lint (full repo)
pnpm format                  # biome format --write
pnpm format:check            # biome format (no write) — part of the pre-push gate
```

Pre-push gate (run all five before opening a PR): `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check`.

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

### Distribution via `.well-known/opencode`

The primary way these plugins reach users: a server publishes a `.well-known/opencode` document (an `auth` block + a `config` block listing `plugin` + `provider`), and `opencode auth login <url>` adopts it — no local `opencode.json` needed. OpenCode re-fetches and merges that `config` on every launch, so the provider definition is **not** stored on the client (only a `wellknown` pointer lands in `auth.json`; the real OAuth token lives in the oauth2 plugin's own cache). When debugging "where is this provider configured?", the answer is usually "served from the well-known URL, fetched fresh each boot." Full mechanics + gotchas in [`docs/well-known.md`](docs/well-known.md).

### Per-package file layout convention

All plugins follow the same shape:

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

`opencode-ratelimit` follows the same shape **minus `cache.ts`** (its rate-limit state is in-memory only — a reset window is seconds, so persisting it would only serve stale data) and **plus `headers.ts`** (a pure parser for the `x-ratelimit-*` triple). It is also the only plugin that injects a custom `fetch` into `provider.options.fetch` (the sole way to observe response status/headers, since OpenCode has no post-response hook) rather than only reading/merging config.

**Important — two entry points per published package:**

- `"."` resolves to `dist/index.js` and is what OpenCode discovers. The host iterates every named export and rejects anything that isn't a `Plugin` function, so `index.ts` is kept *intentionally tiny* (a single `export { default } from "./opencode.js";`). See [`packages/opencode-oauth2/src/index.ts`](packages/opencode-oauth2/src/index.ts) and the matching `slim main entry` fix in commit history.
- `"./lib"` resolves to `dist/lib.js` and is the library API for embedders. New utility exports go through `lib.ts`, not `index.ts`.

### Composition contract (models-info)

`@vymalo/opencode-models-info` runs after other `config` hooks have populated `input.provider`. It opts in per provider via `options.meta.modelsInfoUrl` and the merge is **upstream-wins**: a field already present on a model entry is never overwritten. This is deliberate — it means the plugin is safe to enable globally and lets handwritten `opencode.json` config take precedence. The escape hatch is `options.meta.modelsInfoOverwrite` (array of mapped field names) — fields listed there are exempt from upstream-wins so the endpoint value can replace one another plugin auto-stamped. The motivating case: oauth2's discovery writes a *normalized* `name` (`kimi-k2.6` → `Kimi K2.6`) onto every model, which upstream-wins then freezes; `"modelsInfoOverwrite": ["name"]` lets the endpoint's real name win. (`modalities`/`attachment` are *not* pre-stamped by oauth2, so vision support enriches without an override — if it's missing, suspect a stale cache or failed fetch, not the merge.)

**The one cross-plugin coupling.** Despite being decoupled at the import level, the two plugins meet at the shared config object: oauth2's `config` hook stamps a freshly-ensured bearer onto `provider.options.headers.Authorization`, and models-info forwards `options.headers` when it fetches `modelsInfoUrl`. So an OAuth2-protected metadata endpoint works automatically — **but only if `@vymalo/opencode-oauth2` is listed before `@vymalo/opencode-models-info` in `plugin`** (config hooks run in registration order). The bearer comes from a refresh-only ensure (`ensureAccessToken(id, { interactive: false })`) so a near-expiry token is refreshed rather than skipped; `chat.headers` re-injects a fresh token per request, so a stale config-time header can only ever affect the metadata fetch, never inference. Symptom of getting this wrong: `models_info_fetch_failed_no_cache` (HTTP 401).

When changing the mapping in [`packages/opencode-models-info/src/mapping.ts`](packages/opencode-models-info/src/mapping.ts):

- OpenRouter's `pricing.prompt` / `.completion` are USD-per-token strings; OpenCode's `cost.input` / `cost.output` are USD-per-1M-tokens numbers. The conversion (`* 1_000_000` then round to 6 decimals) lives in `mapping.ts`. Don't move it.
- `limit` only emits if **both** `context` (`top_provider.context_length ?? context_length`) and `output` (`top_provider.max_completion_tokens`) are known — partial `limit` blocks are invalid in OpenCode's schema. Consequence worth knowing: if the source endpoint omits these, OpenCode backfills the runtime model's required `limit` to `{0,0}` and its UI treats the model as incomplete, hiding `cost` too even though it enriched fine. This is a *source-data* gap, not a plugin bug — see [`docs/troubleshooting.md`](docs/troubleshooting.md).
- Modalities are filtered to OpenCode's enum (`text | audio | image | video | pdf`) — `"file"` and other OpenRouter values are dropped.
- `tool_call` / `reasoning` / `temperature` are derived from the entry's `supported_parameters` array (`tools`/`tool_choice` → `tool_call`; `reasoning`/`reasoning_effort`/`thinking` → `reasoning`). The mapper only ever sets these to `true`; a capability the UI shows as disabled usually means the field is absent from the endpoint payload.

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
- **Biome and the `.claude` worktree path.** `biome.json` excludes `**/.claude`, and Claude Code worktrees live under `.claude/worktrees/<id>/`. A bare `biome … .` therefore self-excludes (the `.` arg resolves under `.claude`) and silently processes **zero** files. To avoid that trap, the root `lint` / `format` / `format:check` scripts pass **explicit paths** (`packages test-env *.json`) instead of `.` — Biome evaluates `includes` relative to `biome.json`, so those relative paths never hit the `.claude` exclusion and the scripts work identically from a worktree or the main checkout. If you add a new top-level lintable directory, add it to those three scripts (otherwise it won't be checked).

## Releasing

Versions are bumped **manually** — there are no changesets and no release scripts. `@vymalo/opencode-oauth2`, `@vymalo/opencode-models-info`, and `@vymalo/opencode-ratelimit` are the three published packages; the workspace root and `@vymalo/opencode-oauth2-bundle` are `private`. The bundle depends on oauth2 via `workspace:*`, so a version bump touches only `package.json` `version` fields (no lockfile change). All five packages (the three published plus the two private) are kept on the **same version line** — currently `0.6.1` — and bumped together in one PR. The user runs the actual `npm publish` after the bump PR merges.

## Design docs and plans

- [`plans/prd.md`](plans/prd.md) — original oauth2 PRD with the phased roadmap.
- [`plans/models-info-plan.md`](plans/models-info-plan.md) — design doc for the metadata plugin, including the OpenRouter→OpenCode field mapping table.
- [`docs/`](docs/) — the architecture doc is canonical for hook behavior. Also: [`well-known.md`](docs/well-known.md) (`.well-known/opencode` distribution), [`models-info.md`](docs/models-info.md) (enrichment composition + caching), [`troubleshooting.md`](docs/troubleshooting.md) (symptom-keyed fixes), plus GitHub Actions / Kubernetes cookbooks and local-dev setup.
