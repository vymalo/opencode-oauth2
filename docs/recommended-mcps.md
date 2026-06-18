# Recommended MCP servers (adopt, don't rebuild)

This suite has a standing principle: **don't build a `@vymalo` plugin for something a mature MCP
server already does well.** (We don't ship a Kubernetes plugin because
[`kubernetes-mcp-server`](https://github.com/containers/kubernetes-mcp-server) exists.)

When we scoped a batch of "common utility" plugins, several candidates turned out to be **already
solved** by actively-maintained servers. Rather than re-implement them, wire the existing server
into OpenCode (or any MCP client) directly. `@vymalo/opencode-devtools` deliberately fills only the
gaps those servers *don't* cover (deterministic local utilities — see [`devtools.md`](devtools.md)).

> Survey snapshot: June 2026. Star counts / versions move — spot-check the repo before depending on
> one. Pin versions and review permissions; an MCP server runs with your privileges.

## Memory

| Need | Adopt | Notes |
| --- | --- | --- |
| Simple recall (knowledge graph) | [`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) | Official, maintained. Entities + relations + observations over a JSON file. |
| Semantic / vector recall | [Mem0](https://github.com/mem0ai/mem0) | Heavily-funded, semantic extraction + vector search; self-hosted or SaaS. |

```jsonc
{ "mcpServers": { "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } } }
```

## Android & iOS device control

| Need | Adopt | Notes |
| --- | --- | --- |
| adb + iOS in one server | [`@mobilenext/mobile-mcp`](https://github.com/mobile-next/mobile-mcp) | List devices, install/launch, screenshot, tap/swipe/type, UI tree — Android **and** iOS, real + emulated. |
| Xcode-build-aware iOS sim | [`getsentry/XcodeBuildMCP`](https://github.com/getsentry/XcodeBuildMCP) | Build + run + simulator + UI automation; Sentry-maintained. |

```jsonc
{ "mcpServers": { "mobile": { "command": "npx", "args": ["-y", "@mobilenext/mobile-mcp"] } } }
```

## Database / SQL

| Need | Adopt | Notes |
| --- | --- | --- |
| Postgres + MySQL + SQLite | [`@bytebase/dbhub`](https://github.com/bytebase/dbhub) | One MIT server; **read-only mode**, row limits, schema introspection. (The official `server-postgres`/`server-sqlite` were archived — had a SQL-injection CVE. Don't use them.) |
| Deep Postgres DBA | [`crystaldba/postgres-mcp`](https://github.com/crystaldba/postgres-mcp) | Health checks, index tuning, EXPLAIN/workload analysis. |

```jsonc
{ "mcpServers": { "db": { "command": "npx", "args": ["-y", "@bytebase/dbhub", "--readonly", "--dsn", "postgres://…"] } } }
```

## Deep `jq` / YAML / TOML querying

`@vymalo/opencode-devtools`'s `convert` group covers JSON/YAML/TOML/CSV interconversion + JSONPath.
For **deep `jq`-compatible** querying and schema validation, adopt:

- [`bitflight-devops/mcp-json-yaml-toml`](https://github.com/bitflight-devops/mcp-json-yaml-toml) — round-trip-safe conversion + `yq`/`jq`-style queries (no CSV — that's the slice devtools adds).

## Symbolic / CAS maths

`devtools`' `math` group does arbitrary-precision arithmetic, units, base conversion and stats. For
**symbolic** calculus/algebra (SymPy/Maxima-backed), adopt:

- [`SHSharkar/MCP-Mathematics`](https://github.com/SHSharkar/MCP-Mathematics) — broad symbolic +
  financial coverage (Python dependency).
