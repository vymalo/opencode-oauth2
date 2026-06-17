# Changelog

All notable changes to the **OpenCode Toolbelt** — the `@vymalo/*` plugin suite for [OpenCode](https://opencode.ai) — are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All nine workspace packages move on **one version line** and are released together, so a single entry covers the whole suite. Each line is tagged with the package it touches (`oauth2`, `models-info`, `ratelimit`, `browser`, `browser-mcp`, `browser-extension`, `code-index`). PR references link to the change.

## [0.8.1] — 2026-06-17

### Added

- **code-index** *(experimental, private — not published)*: a personal code-intelligence plugin (`@vymalo/opencode-code-index`). Registers `code_*` tools — `code_symbol`, `code_callers`, `code_callees`, `code_references`, `code_blast_radius`, plus `index_refresh` / `index_status` — backed by an embedded **DuckDB** store and a **tree-sitter** symbol graph. The index is content-addressed by git blob and scoped per branch (a branch is a `path→blob` manifest), so branch/worktree switches re-index only the delta and `blast_radius` stays branch-correct. Call-graph resolution is *sound but partial* (tree-sitter only, no type info). Lives in the workspace for convenience; may be removed. See [`docs/code-index.md`](docs/code-index.md) and [`plans/code-index.md`](plans/code-index.md).
- **all plugins:** A new `trace` log tier (below `debug`) carrying fine-grained, per-step breadcrumbs — config-hook steps and providers considered (oauth2), each model match/merge decision (models-info), every parsed `x-ratelimit` header and throttle/tier choice (ratelimit), and every bridge frame routed between agents and executors plus host/guest election (browser). It's unlocked by running the host at `--log-level DEBUG` (OpenCode's `DEBUG` now maps to `trace`), so a clean run stays quiet but "tell me everything" is one flag away. ~85 new events. ([#56](https://github.com/vymalo/opencode-oauth2/pull/56))

### Fixed

- **oauth2:** Fix a `sync_failed … ENOENT … rename '<serverId>.json.tmp' -> '<serverId>.json'` crash when several OpenCode instances boot at once (e.g. the desktop app restoring every project window in parallel) and all sync the same provider. The model-sync cache wrote to a **shared** `<serverId>.json.tmp` temp file, so one writer's atomic rename consumed the temp file another was about to rename. Temp files are now per-writer (`pid` + uuid) and cleaned up on failure. The `models-info` cache was hardened the same way (uuid + orphan cleanup). ([#54](https://github.com/vymalo/opencode-oauth2/pull/54))
- **browser / browser-extension:** A rejected bridge handshake (`browser_handshake_rejected reason=bad_token`) no longer floods the bridge ~once a second. The broker sends a `rejected` frame before closing, so the extension can tell a token rejection from a network drop: it shows a clear, neutral error (the token may be stale/rotated, or a different host is running) and **backs off to a slow retry** instead of hammering. Crucially it still **auto-recovers** the moment a good host returns — e.g. after you restart the process that owns the bridge port — with no manual reconnect. ([#55](https://github.com/vymalo/opencode-oauth2/pull/55))
- **browser:** Fix bridge **token divergence** — the failure where the extension sends the *current* token but a long-lived host (e.g. an IDE-embedded OpenCode) keeps rejecting it. Three changes: (1) `bridge.json` is now written **atomically** (temp + `rename`), so a concurrent boot can't catch a torn/empty file and regenerate a fresh token over the shared one; (2) only the **host** writes the file (not every instance at load), and only when the file doesn't already match its `(port, token)` — so a port change and an explicit operator token stay authoritative, while a concurrent host doesn't thrash it (an explicit token is also never overridden by a file reload); (3) on a bad-token handshake the host **re-reads `bridge.json` and adopts a rotated token**, so a rotation reaches a running host without a restart (logged `browser_bridge_token_reloaded`). ([#57](https://github.com/vymalo/opencode-oauth2/pull/57))

### Changed

- **browser:** `browser_handshake_rejected` now logs non-secret token **fingerprints** (`expected` vs `got`, plus `role`/`client`) instead of a bare `reason`, so a token mismatch is diagnosable from the log without exposing the secret — a same-length, different-value pair points at a stale/rotated host rather than a paste error. ([#55](https://github.com/vymalo/opencode-oauth2/pull/55))

## [0.8.0] — 2026-06-14

The release that turns the **browser** plugin from "drives tabs" into "collaborates with a human", and reframes the whole repo as a suite rather than a single auth plugin.

### Added

- **browser:** Human-in-the-loop UI feedback — a new opt-in `interactive` tool group with `browser_request_feedback`, a blocking, branded in-page overlay (point / confirm / choose) that the broker can tear down via a `cancel` frame on abort or timeout. A docked side-panel fallback handles overlay-blocked pages. ([#49](https://github.com/vymalo/opencode-oauth2/pull/49))
- **browser-extension:** A fake-chrome test harness plus background-worker unit tests, lifting the extension off "verified by hand only". ([#50](https://github.com/vymalo/opencode-oauth2/pull/50))

### Changed

- **docs:** The workspace README is rebranded as the **OpenCode Toolbelt** — a suite of five published plugins, not just the flagship auth plugin. Per-package npm badges, a "what's in the belt" table, and a suite-level diagram. ([#51](https://github.com/vymalo/opencode-oauth2/pull/51))

### Documentation

- **browser:** ADR-0001 records why the bridge uses the `ws` package rather than `Bun.serve` or socket.io, and a stale `Bun.serve` comment was fixed. ([#47](https://github.com/vymalo/opencode-oauth2/pull/47))
- **browser:** Documented where `bridge.json` lives on the host so the extension token is easy to find. ([#48](https://github.com/vymalo/opencode-oauth2/pull/48))

## [0.7.3] — 2026-06-14

### Fixed

- **browser:** Serve the bridge over `ws` so it runs under **Node** (the desktop OpenCode runtime), not only Bun. ([#46](https://github.com/vymalo/opencode-oauth2/pull/46))

## [0.7.2] — 2026-06-14

### Fixed

- **all plugins:** Stop flooding stdout — defer to OpenCode's logger instead of writing structured events directly to the console. ([#45](https://github.com/vymalo/opencode-oauth2/pull/45))

## [0.7.1] — 2026-06-14

A large development burst released as a patch: the MCP server, multi-client routing, and store automation all landed here.

### Added

- **oauth2:** `responseApi` toggle to route inference through `/v1/responses` (and inject the `output_index` / `content_index` fields some gateways drop on SSE). ([#37](https://github.com/vymalo/opencode-oauth2/pull/37))
- **models-info:** `meta.modelsInfoOverwrite` — opt specific fields out of the upstream-wins merge so a metadata endpoint can replace a value another plugin auto-stamped. ([#38](https://github.com/vymalo/opencode-oauth2/pull/38))
- **browser-mcp:** New published package — an MCP stdio server hosting the same bridge and exposing the same `browser_*` catalog over the Model Context Protocol, so any MCP client (Claude Code, Cursor, Cline, …) can drive the extension. Screenshots return as inline image content.
- **browser:** Multi-client routing via an auto-elect broker — multiple executors (extensions) and multiple agents (plugin / MCP / sessions) share one bridge, routed by named-group ownership, with host-or-guest election and failover. Plus 16 new actions, a shared tool catalog with group gating, true full-page capture on the content executor, and plugin-initiated + auto-on-shutdown release.
- **browser-extension:** daisyUI (nord / aqua) restyle with a "how it works" guide, and CI auto-submit to the Chrome Web Store and Firefox AMO (each store gated on its own secrets).

### Fixed

- **browser:** Persist the bridge token across sessions. ([#43](https://github.com/vymalo/opencode-oauth2/pull/43))
- **browser:** Broker release is scoped to owned executors only; an empty token is no longer treated as an explicit one; stale query refs are cleared.
- **browser-extension:** Pin `gecko.id` and declare `data_collection_permissions` for AMO.

## [0.7.0] — 2026-06-12

### Added

- **browser:** New published `@vymalo/opencode-browser` plugin — `browser_*` tools (open, navigate, click, type, scroll, screenshot, snapshot, …) registered via `Hooks.tool`, backed by a localhost WebSocket bridge — plus a private companion Chromium/Firefox extension under `apps/`. Because an extension can't host a server, the plugin is the server and the extension dials out. Tabs are organized into named groups; targeting is via snapshot refs, CSS selectors, or coordinates; screenshots are written to disk and surfaced as a path. ([f463429](https://github.com/vymalo/opencode-oauth2/commit/f463429))

---

Releases before `0.7.0` predate this changelog. For that history, see the [commit log](https://github.com/vymalo/opencode-oauth2/commits/main).
