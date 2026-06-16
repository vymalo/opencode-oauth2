# Code Index (`@vymalo/opencode-code-index`)

> **Status: experimental / private.** This is a personal, per-project plugin — it
> is **not** published to npm and is **not** part of the supported five-plugin
> suite. It lives in the workspace for convenience and may be removed. Design
> rationale lives in [`plans/code-index.md`](../plans/code-index.md).

An OpenCode plugin that indexes a repository into an embedded **DuckDB** store and
exposes `code_*` tools the model can call to navigate structure that plain grep
can't answer cheaply — "who calls this", "blast radius of changing this symbol",
"where is this defined". The call graph is built with **tree-sitter**.

## Why it exists

Agentic grep already covers most code search. What it *can't* do cheaply is
multi-hop structural questions:

- **`code_blast_radius`** — every symbol that transitively depends on a target.
- **`code_callers` / `code_callees`** — one-hop call edges.

Those are the differentiated value; the rest of the tools round out navigation.

## Tools

| Tool | Args | Returns |
| --- | --- | --- |
| `code_symbol` | `name` | Definition site(s) (`file:line`) on the current branch. |
| `code_callers` | `name` | Symbols that directly call/reference `name`. |
| `code_callees` | `name` | Symbols `name` directly calls. |
| `code_references` | `name` | Every resolved reference site (`file:line`, caller, kind/confidence). |
| `code_blast_radius` | `name` | Transitive dependents of `name`. |
| `index_refresh` | — | Re-index the current branch (incremental — only changed blobs are parsed). |
| `index_status` | — | Branch, file/symbol/edge counts, DB path. |

The first `code_*` call on a branch **indexes it lazily**; subsequent calls reuse the
store. Use `index_refresh` after edits to pick up changes.

## How indexing works (the load-bearing model)

The index is **content-addressed by git blob** and **scoped per branch**:

- Symbols and call edges are keyed by the file's git **blob sha**, never by branch —
  so a blob is parsed once and shared across every branch/worktree that contains it.
- A **branch is just a manifest** (`path → blob`). Switching branches re-indexes only
  the blobs that changed; the rest is reused.
- Name resolution happens **at query time** against the active branch's manifest, so
  the same edge yields branch-correct answers. Refactor `auth` so it no longer calls
  `util` on one branch, and `blast_radius(util)` shrinks on that branch only.

The store lives at `<cache>/<repoId>.duckdb` (per-OS cache dir, keyed by the repo's
root-commit sha) so all worktrees of a repo share one index. It only exists where you
indexed — idle cost is a file on disk.

### Resolution is *sound but partial*

The call graph is built from tree-sitter alone, with **no type information**. It captures:

- bare calls `foo()`, constructors `new Ctor()` (confidence `name`),
- `this.method()` within a class (confidence `this`).

It deliberately **drops** generic `obj.method()` member dispatch — most of it is
library/builtin noise (`Date.now()`, `arr.push()`, `logger.debug()`) that can't be
resolved without type info and would pollute the graph. Consequence: cross-object
method-dispatch edges may be missing, so `code_callers` / `code_blast_radius` can
*under-report* (never over-report). The tool output flags results as structural.

## Configuration

Enable it like any OpenCode plugin and (optionally) pass options:

```jsonc
{
  "plugin": ["@vymalo/opencode-code-index"],
  "pluginConfig": {
    "@vymalo/opencode-code-index": {
      "enabled": true,
      "extensions": ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
      "dbPath": null,        // default: <cache>/<repoId>.duckdb
      "autoIndex": false
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to register no tools. |
| `extensions` | TS/JS family | File extensions (without the dot) to parse. |
| `dbPath` | per-repo cache path | Override the DuckDB file location. |
| `autoIndex` | `false` | Reserved for eager indexing on load (lazy first-touch is the default). |

## Limitations & roadmap

- **TypeScript/JavaScript only** today (tree-sitter grammar). Other languages are
  additive (a grammar + extension mapping).
- **Structural graph only.** A precise method-dispatch tier (TypeScript language
  server / SCIP) is a future enrichment, tagged via the edge `confidence` column.
- **Prose search deferred.** Semantic `docs_search` / `memory_search` over docs/ADRs
  via a remote OpenAI-compatible embeddings endpoint is designed
  ([`plans/code-index.md`](../plans/code-index.md) §10) but not yet implemented.
- **Indexes committed HEAD**, not the dirty working tree — `index_refresh` after
  commits to refresh.
