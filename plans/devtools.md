# Devtools utilities plugin + MCP (design)

Status: **implemented in 0.9.0.** New published pair: `@vymalo/opencode-devtools` (OpenCode plugin)
and `@vymalo/opencode-devtools-mcp` (MCP stdio server) — same dual-ship shape as
`opencode-browser` / `opencode-browser-mcp`. User-facing reference: [`docs/devtools.md`](../docs/devtools.md).

**Shipped vs deferred in v1.** All six groups shipped (`math`, `codec`, `crypto`, `datetime`,
`convert`, `http`). Deferred (documented in `docs/devtools.md` → "Not in v1"): `http` save/replay
collections (would add a stateful `cache.ts`), configurable `math` precision (fixed at 64 digits),
and symbolic CAS. `math` uses **mathjs** (hardened — see Security); the engine question below was
resolved in its favour.

## Context

We surveyed common "tools the model calls" candidates and ran a build-vs-adopt prior-art sweep of
the 2026 MCP ecosystem (full notes below). The governing principle — borrowed from the user's k8s
call ("there's already `kubernetes-mcp-server`, don't rebuild it") — is: **only build where no
mature MCP already exists.** That filter inverts the obvious plan.

The candidates fell into two clean clusters:

- **Adopt (mature MCP already exists):** memory, android/adb, iOS-simulator, database/SQL, and the
  jq/YAML/TOML slice of "convert." These are heavyweight, stateful, device-, or network-bound — and
  each already has an actively-maintained, published server. Building `@vymalo` versions would
  re-implement solved problems.
- **Build (genuine gap):** math, codec, crypto, datetime, http, and the **CSV** slice of convert.
  Every one is a small, pure-TS, zero-auth, **deterministic local utility** — and the one all-in-one
  that used to cover them (`it-tools-mcp`) is **deprecated/archived**, leaving an orphaned audience.

So the deliverable is **one grouped utilities plugin** (these gaps as tool *groups*, mirroring
`opencode-browser`'s `groups` gating) plus **one doc** recommending the adopt-these servers.

### Prior-art verdicts (June 2026 sweep)

| Domain | Verdict | Best existing option / note |
| --- | --- | --- |
| memory | **ADOPT** | `@modelcontextprotocol/server-memory` (maintained, npm); Mem0 (~53k★) for semantic recall. Saturated space. |
| adb / android | **ADOPT** | `@mobilenext/mobile-mcp` (~5.2k★, npm+registry) — full adb surface **and** iOS. |
| iOS simulator | **ADOPT** | Collapses into mobile-mcp; or Sentry's `XcodeBuildMCP` (~5.9k★) for build-aware sim control. |
| db / sql | **ADOPT** | `bytebase/dbhub` (MIT) — PG+MySQL+SQLite, read-only mode, row limits. Official PG/SQLite servers were **archived** (SQLi CVE). |
| convert (jq/yaml/toml) | **ADOPT** | `bitflight-devops/mcp-json-yaml-toml`. Our only gap vs it: **CSV**. |
| **math** | **BUILD** | No official anchor; fragmented community. Scope: precise arithmetic + units (pure-TS). |
| **codec** | **BUILD** | `it-tools-mcp` (the all-in-one) deprecated; gzip unserved; alternatives paywalled. |
| **crypto** | **BUILD** | Same dead leader; ULID + keygen effectively unserved. |
| **datetime** | **BUILD (thin)** | Official `time` server is timezone-only — no parse/diff/cron. |
| **http** | **BUILD** | Official `fetch` is GET-to-markdown only; no mature curl-like REST/GraphQL + replay tool. |

## Goals (decided)

- **One plugin + one MCP**, not N tiny packages. Groups are the unit of opt-in, exactly like
  browser's `page`/`control`/`debug`/`interactive`.
- **Pure compute, no server.** Unlike `opencode-browser`, devtools hosts **no bridge, no `ws`, no
  transport, no broker** — every tool is a pure (or near-pure) in-process function. This is much
  simpler than the browser plugin: drop `protocol.ts`/`transport.ts`/`broker.ts`/`endpoint.ts`/
  `token-file.ts` from that template entirely.
- **Single source of truth** for the tool surface in `catalog.ts` + `schema.ts`, shared with the MCP
  server via the `./lib` export — the browser pattern.
- **Safe by default.** The five deterministic groups (`math`, `codec`, `crypto`, `datetime`,
  `convert`) are on by default. `http` is the only group with **network egress** and is **opt-in**
  (off by default), like browser's `debug`/`interactive`.

Non-goals (v1): symbolic CAS / matrices beyond basics (that means bundling SymPy/Maxima — Python,
heavy — out of scope; recommend `MCP-Mathematics` for that); deep `jq` compatibility (recommend
`bitflight-devops/mcp-json-yaml-toml`); JWT *verification* / signing (decode only); cross-host or
authenticated http collections.

## Tool surface (the catalog)

Tool names are `snake_case`, namespaced by group. Initial cut (~24 tools):

### `math` (default on) — pure, deterministic
- `math_eval` — evaluate an arithmetic/expression string at configurable precision. **Sandboxed**
  (no code exec, no function imports, no prototype access — see Security).
- `math_convert_unit` — value + from-unit + to-unit across categories (length, mass, time, data,
  temperature, …).
- `math_stats` — mean / median / mode / stdev / variance / min / max / sum over a number array.
- `math_base` — radix conversion (bin/oct/dec/hex/arbitrary 2–36).

### `codec` (default on) — Node built-ins, zero deps
- `codec_base64` — encode/decode (incl. base64url).
- `codec_hex` — encode/decode.
- `codec_url` — `encodeURIComponent`/decode and full-URL component parse.
- `codec_jwt_decode` — split + base64url-decode header/payload (no signature verify; flagged in
  output as *unverified*).
- `codec_gzip` — gzip/gunzip + deflate/inflate (the capability no surveyed server offers).

### `crypto` (default on) — `node:crypto`, one tiny dep for ULID
- `crypto_hash` — md5 / sha1 / sha256 / sha512 over text or base64 bytes.
- `crypto_hmac` — same algos, keyed.
- `crypto_uuid` — v4 (built-in) + v7 (time-ordered).
- `crypto_ulid` — ULID (the unserved gap).
- `crypto_random` — N random bytes as hex/base64; secure password/string generator.
- `crypto_keypair` — generate RSA / EC / ed25519 keypair (PEM/JWK out).

### `datetime` (default on) — Luxon + cron libs
- `datetime_now` — current time in an IANA zone, multiple formats.
- `datetime_parse` — parse a string (incl. natural-ish + epoch) → normalized ISO + components.
- `datetime_format` — reformat between formats / zones.
- `datetime_diff` — duration between two instants, in chosen units.
- `datetime_convert_tz` — IANA timezone conversion (Luxon/Intl, not hand-rolled).
- `datetime_cron` — explain a cron expression in plain English **and** list the next N runs (the two
  things the official `time` server pointedly omits).

### `convert` (default on) — interconvert + JSONPath; CSV is the differentiator
- `convert_data` — interconvert JSON ⇄ YAML ⇄ TOML ⇄ **CSV** (round-trip-safe where possible).
- `convert_query` — JSONPath query over a JSON/YAML/TOML doc (pure-JS `jsonpath-plus`). *Deep `jq`
  → recommend `bitflight-devops/mcp-json-yaml-toml`; we cover CSV + JSONPath, the gaps it leaves.*

### `http` (opt-in, off by default) — network egress + state
- `http_request` — method / url / headers / body; structured response (status, headers, parsed
  body). Built on the runtime `fetch` (undici) — no dep.
- `http_graphql` — POST a GraphQL query + variables; structured `data`/`errors`.
- `http_save` / `http_replay` — name a request and replay it later (small `FileCacheStore`-backed
  collection — the **only** group that needs `cache.ts`).

## Configuration

Plugin factory options (set where OpenCode passes plugin config; MCP server reads the same shape
from flags/env):

```ts
createDevtoolsPlugin({
  groups: ["math", "codec", "crypto", "datetime", "convert"], // http omitted by default
  math: { precision: 64 },
  http: {
    allowPrivateNetwork: false,   // SSRF guard: block localhost / RFC-1918 / link-local by default
    allowlist: [],                // optional host allowlist
    timeoutMs: 30_000
  }
})
```

## File layout (per-package convention, minus the bridge machinery)

```
packages/opencode-devtools/
├── src/
│   ├── index.ts        # export { default } from "./opencode.js"  (kept slim — host iterates exports)
│   ├── opencode.ts     # createDevtoolsPlugin(opts) → Plugin
│   ├── plugin.ts       # group gating + tool wiring core (testable, split from opencode.ts)
│   ├── lib.ts          # public API: catalog + schema (the "./lib" subpath the MCP imports)
│   ├── catalog.ts      # neutral tool surface — single source of truth, shared with MCP
│   ├── schema.ts       # JSON Schema per tool
│   ├── tools.ts        # Hooks.tool adapter over the catalog
│   ├── groups/
│   │   ├── math.ts  codec.ts  crypto.ts  datetime.ts  convert.ts  http.ts
│   ├── cache.ts        # FileCacheStore — ONLY used by the http group's save/replay
│   └── logging.ts      # structured JSON events, snake_case (devtools_tool_invoked, …)
└── test/

packages/opencode-devtools-mcp/
├── src/
│   ├── mcp.ts          # stdio bin; reuses @vymalo/opencode-devtools/lib catalog + schema
│   └── …               # group-filtered catalog over MCP; text results (no images)
```

Two entry points per published package, same as the rest of the suite: `"."` → slim `dist/index.js`
(OpenCode discovery), `"./lib"` → `dist/lib.js` (the catalog/schema the MCP consumes).

## Security (load-bearing — candidates for ADRs)

1. **`math_eval` sandbox.** Expression evaluation is the one place arbitrary input meets a parser.
   Must be AST/whitelist-based, never `eval`/`Function`. If using `mathjs`, lock it down
   (disable `import`/`createUnit`/`evaluate` of function definitions, cap matrix size, set a node
   limit). The survey flagged AST-vs-`eval` as the real quality differentiator in this space. → **ADR.**
2. **`http` SSRF guard.** Egress can reach internal services. Default `allowPrivateNetwork: false`
   blocks localhost / RFC-1918 / link-local / metadata IPs; optional `allowlist`. Off-by-default
   group + this guard is the whole reason http is segregated. → **ADR.**
3. **Group gating = blast-radius control.** Mirrors browser's opt-in `debug`/`interactive`. Only the
   safe deterministic groups ship on by default.

## Dependencies (keep light — repo norm)

- `math`: `mathjs` (sandboxed) **or** `decimal.js` + a units lib — decide in the math ADR (mathjs is
  one dep but needs hardening; decimal.js + `convert-units` is lighter but more glue).
- `codec`: **none** — `Buffer`, `node:zlib`.
- `crypto`: `node:crypto` + a small `ulid` dep (uuid v7 hand-rolled or `uuid`).
- `datetime`: `luxon` (IANA via Intl) + `cronstrue` (explain) + `cron-parser` (next runs).
- `convert`: `yaml`, `@iarna/toml`, a CSV lib (`papaparse`/`csv-parse`), `jsonpath-plus` (pure JS).
- `http`: **none** — runtime `fetch`/undici; collections via the local `cache.ts`.

## Testing

Pure functions ⇒ trivially unit-testable; target the browser-package coverage bar (~88%). Two seams
needed for determinism: a **clock** (datetime/uuidv7/ulid) and a **random source** (crypto) injected
DI-style, plus a **fake `fetch`** for the http group (same `BridgeTransport`-seam idea browser uses).
MCP server: e2e-only stdio `bin` excluded from the coverage metric, like `opencode-browser-mcp`'s
`mcp.ts`.

## Phasing

- **Phase 0 — scaffold.** Package pair, `catalog`/`schema`/`tools`/`plugin`/`opencode`/`lib`,
  group-gating, logging, DI clock/random seams, MCP stdio wrapper. Establishes the reusable template.
- **Phase 1 — `codec` + `crypto`.** Zero/near-zero deps, highest gap value (dead `it-tools-mcp`
  audience). Fastest to land.
- **Phase 2 — `datetime`.** Luxon + cronstrue + cron-parser.
- **Phase 3 — `math`.** Needs the sandbox ADR resolved first.
- **Phase 4 — `convert`.** CSV + interconvert + JSONPath.
- **Phase 5 — `http`.** Opt-in group, SSRF guard, cache-backed save/replay. Last — different risk
  profile, only group with egress + state.
- **Docs (each phase, per repo methodology — code + docs same PR):** `docs/devtools.md` (tool
  reference, groups, security), `docs/recommended-mcps.md` (the adopt guide — memory/mobile/db with
  `opencode.json` wiring snippets), `CHANGELOG.md` entry, and a new row in the `CLAUDE.md` /
  `AGENTS.md` package table (keep the two in sync).

## The adopt guide (`docs/recommended-mcps.md`)

Short doc telling users to wire these existing servers via OpenCode's MCP config rather than wait for
a `@vymalo` equivalent:

- **memory** → `@modelcontextprotocol/server-memory` (simple knowledge-graph) or **Mem0** (semantic).
- **android + iOS** → `@mobilenext/mobile-mcp` (one server, both platforms); `XcodeBuildMCP` for
  Xcode build-aware iOS sim flows.
- **database** → `@bytebase/dbhub` (PG/MySQL/SQLite, read-only mode).
- **jq/YAML/TOML depth** → `bitflight-devops/mcp-json-yaml-toml` (we cover CSV + JSONPath; it covers
  deep jq).

## Open questions

- `math` engine: `mathjs` (hardened) vs `decimal.js` + units lib — resolve in the sandbox ADR.
- Does `convert` carry the full JSON/YAML/TOML matrix (cohesion, slight overlap with bitflight) or
  **only** the CSV/JSONPath gaps (leaner, zero overlap)? Leaning full-matrix for one-stop ergonomics.
- ADR worth writing: "one grouped devtools plugin vs N single-purpose plugins" — records why we
  closed off the per-domain-package path (release/boilerplate overhead for tiny utilities).
```
