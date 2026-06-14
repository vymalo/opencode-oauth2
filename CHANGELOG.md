# Changelog

All notable changes to the **OpenCode Toolbelt** — the `@vymalo/*` plugin suite for [OpenCode](https://opencode.ai) — are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All eight workspace packages move on **one version line** and are released together, so a single entry covers the whole suite. Each line is tagged with the package it touches (`oauth2`, `models-info`, `ratelimit`, `browser`, `browser-mcp`, `browser-extension`). PR references link to the change.

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
