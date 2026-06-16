# Code-Index OpenCode Plugin — Design Doc (draft)

> **Status:** draft for discussion. **Scope:** a *personal*, per-project OpenCode
> plugin — installed globally in `~/.config/opencode`, activated per-project when an
> index is present. **Not** a `@vymalo` published package and **does not** live in
> this repo (this file is a standalone artifact to react to; move/delete freely).

## 1. Goal

Give the agent code-intelligence tools that plain agentic grep can't cheaply provide,
without standing up a database server by default.

Two capabilities, deliberately served by **different mechanisms**:

- **Structure (#4)** — "who calls this", "blast radius of changing X", import graph.
  Served by a **tree-sitter symbol/reference graph**. grep cannot answer multi-hop.
- **Prose (#3)** — docs, ADRs, issues, long comments. Served by **embeddings**.
  Similarity genuinely beats grep on natural language.

**Explicit non-goal:** semantic *vector search over code*. Agentic grep + the symbol
graph already cover it, and it's the part that ages worst (re-embed churn) and pays
least. We do **not** embed code for similarity search.

## 2. Engine

Default to a **single embedded multi-model engine** so the graph and the prose vectors
live in one file with no container.

- **Default (decided):** DuckDB — recursive CTEs for graph traversal (no extension
  needed), `vss`/HNSW for vectors, optional `duckpgq` if SQL/PGQ ergonomics earn it.
  Single file, no server. (CozoDB was considered and **rejected** — abandoned, last
  commit 2024.)
- **Escalation backend (opt-in, large repos only):** FalkorDB or Neo4j for the graph,
  Qdrant for vectors. The store layer is an interface; the engine is swappable per
  project. Neo4j is *never* the default — it's the heavy tier.

The store is a single gitignored file (e.g. `index.duckdb`) parked at a **stable
per-repo location** (see §6), not in the working tree.

## 3. The core idea: content-addressed records + scope

Don't index "the working tree." Index **git blobs**, and tag every record with a
**scope**. This one decision answers multi-branch, multi-worktree, and dev-memory at
once.

- A symbol/chunk is keyed by `blob_sha`, never by branch.
- A **branch is just a manifest**: `path → blob_sha` (it *is* the git tree).
- Switching branches = swap the active manifest + re-index only changed blobs.

### Three scope tiers

| Tier | Blob-keyed? | Location | Shared with team? |
|---|---|---|---|
| `project-committed` (code graph, docs) | yes | project store | yes (derived from git, regenerable) |
| `project-private` (your notes on *this* repo) | no | global per-dev, keyed by repo id | no |
| `global-private` (how *you* work, any repo) | no | user-level | no |

Every record carries `(blob_sha | null, scope, root)`. Branch = manifest selection;
workspace = scope/root filter; dev memory = the non-blob-keyed tiers.

## 4. Schema (sketch — DuckDB/SQL flavor)

```sql
-- Content-addressed source units. One row per unique blob, shared across all
-- branches and worktrees. Never duplicated.
CREATE TABLE blob (
  blob_sha   TEXT PRIMARY KEY,   -- git blob hash
  lang       TEXT,
  indexed_at TIMESTAMP
);

-- Symbols defined within a blob (functions, classes, methods, exports).
CREATE TABLE symbol (
  symbol_id  BIGINT PRIMARY KEY,
  blob_sha   TEXT REFERENCES blob,
  name       TEXT,
  kind       TEXT,               -- function | class | method | const | type | ...
  span_start INT, span_end INT
);

-- Reference edges: a symbol/site in `src_blob` references `dst_name`.
-- Resolution to dst_symbol_id happens at query time against the active manifest,
-- so the same edge is valid on every branch where both blobs are present.
CREATE TABLE ref (
  ref_id     BIGINT PRIMARY KEY,
  src_blob   TEXT REFERENCES blob,
  src_symbol BIGINT,             -- nullable (file-level ref)
  dst_name   TEXT,               -- unresolved name (resolved via manifest)
  kind       TEXT                -- call | import | extends | implements | ...
);

-- Prose chunks (docs/ADRs/comments) + embedding. Also blob-keyed for committed prose.
CREATE TABLE chunk (
  chunk_id   BIGINT PRIMARY KEY,
  blob_sha   TEXT,               -- null for non-file memory tiers
  scope      TEXT,               -- project-committed | project-private | global-private
  root       TEXT,               -- workspace root this belongs to
  text       TEXT,
  model      TEXT,               -- embedding model id (spaces are incomparable across models)
  embedding  FLOAT[N]            -- vss/HNSW; N fixed per index, = configured model's dim
);

-- Per-branch manifest: which blob is at which path. This is the *only* per-branch
-- state. Built from `git ls-tree`; cheap to recompute, cheaper to delta.
CREATE TABLE manifest (
  branch     TEXT,
  root       TEXT,               -- workspace root (monorepo package, etc.)
  path       TEXT,
  blob_sha   TEXT REFERENCES blob,
  PRIMARY KEY (branch, root, path)
);
```

Symbol resolution (`ref.dst_name → symbol_id`) is a **join against the active
manifest**, so a reference resolves to whatever definition exists *on the current
branch*. No per-branch copies of symbols or edges.

## 5. Indexing pipeline

1. **Enumerate** blobs for the active branch via `git ls-tree -r <branch>` (+ stage
   uncommitted changes as synthetic blobs).
2. **Delta only:** index a blob iff its `blob_sha` is absent from `blob`. Unchanged
   files across a branch switch cost nothing.
3. **Parse** each new code blob with tree-sitter → `symbol` rows + `ref` edges.
4. **Chunk + embed** prose blobs → `chunk` rows.
5. **Write/refresh the manifest** for the branch (`git diff --name-only A B` gives the
   delta on switch).
6. Trigger: on demand via `index_refresh`, or a file-watcher debounced on mtime.

**Branch switch cost** = (blobs that differ) only. **Worktree switch** = free (shared
blob pool, just a different active manifest).

## 6. Store location & repo identity

- **Repo id** = hash of the first-commit sha (stable across clones/renames), or
  `git rev-parse --git-common-dir`. Both worktrees and branches map to the same id.
- **Project store** (`project-committed`): under the repo's git-common dir or a global
  cache keyed by repo id — so every worktree/branch shares it.
- **Dev-private stores** (`project-private`, `global-private`): under a per-OS user dir
  (mirrors the existing `~/.claude/.../memory` convention), keyed by repo id (project
  tier) or nothing (global tier).

This is what makes the index **not "fill memory for free"**: it's a per-repo file that
only exists where you indexed, idle cost ≈ a SQLite file on disk.

## 7. Tool surface

| Tool | Tier | Description |
|---|---|---|
| `code_symbol <name>` | structure | Definition(s) + location on the active branch. |
| `code_callers <symbol>` | structure | Direct callers (one hop). |
| `code_callees <symbol>` | structure | What this symbol calls. |
| `code_references <name>` | structure | All reference sites (call/import/extends). |
| `code_blast_radius <symbol>` | structure | Transitive dependents — the killer #4 tool. |
| `docs_search <query>` | prose | Semantic search over committed docs/ADRs/comments. |
| `memory_search <query>` | prose | Search dev-private notes (project + global tiers). |
| `memory_note <text>` | prose | Add a project-private or global-private note. |
| `index_refresh` | — | Incremental re-index of the active branch. |
| `index_status` | — | Branch, root(s), blob/symbol counts, staleness. |

## 9. Resolution strategy (validated by spike #2)

Tree-sitter extraction was spiked on two real files (`oauth2/plugin.ts`,
`browser/broker.ts`). Findings:

- **Definitions are clean and complete** — every class/method/function (incl.
  arrow-const functions) extracted with correct kind/span. The `symbol` table is solid.
- **Call edges split ~50/50:**
  - **Name-resolvable (the backbone):** bare `foo()`, `new Ctor()`, and `this.method()`
    — resolved against the branch's manifest symbol table (per spike #1). ~50% of edges.
  - **`obj.method()` (member dispatch):** the other ~50% — **but most are noise we
    filter out** (`Date.now()`, `arr.push()`, `this.logger.debug()`, field/lib calls).
    The residue that points at *our own typed objects* genuinely needs type info.

**Decision:** the default graph is **tree-sitter-only = sound but partial** — complete
on defs + free-function/ctor/`this` edges, under-reports cross-object method dispatch.
This already beats grep and `blast_radius` runs on it. **Precise OO method resolution is
an opt-in enrichment tier** (TypeScript language server or SCIP), not a default
dependency. `blast_radius`/`code_callers` output should flag results as *structural*
so the agent knows method-dispatch edges may be missing.

Implication: keep `ref.dst_name` unresolved at write time (already the schema) and
resolve at query time against the manifest — and tag each edge with a `confidence`
(`name` | `this` | `typed`) so the enrichment tier can upgrade edges in place later.

## 10. Embedding backend (decided: remote, OpenAI-compatible)

Prose embeddings come from a configurable **OpenAI-compatible `/v1/embeddings`**
endpoint — so the same code targets **Ollama** (local + offline), **OpenAI**, or any
gateway by swapping config. No bundled model, no ONNX runtime.

```jsonc
// per-project config
"embedding": {
  "baseUrl": "http://localhost:11434/v1",   // ollama | openai | gateway
  "model":   "nomic-embed-text",
  "apiKey":  "env:OPENAI_API_KEY",          // optional (ollama needs none)
  "dimensions": 768                          // must match the model
}
```

Contract + consequences:

- **Request:** `POST {baseUrl}/embeddings  { model, input: string[] }` → `data[].embedding`.
  Batch chunks per call at index time.
- **Dim is fixed per index.** DuckDB's `vss` HNSW column is `FLOAT[N]`; `N` = the model's
  dimension. Choosing the model fixes the column.
- **Model = part of the cache key.** Embeddings from different models live in
  **incomparable spaces**. Store `chunk.model`; **changing the model invalidates the prose
  index** (re-embed). This extends the content-addressed idea: a chunk embedding is keyed
  by `(blob_sha, model)`, so swapping models re-embeds rather than silently mixing spaces.
- **Idle cost stays zero**, but `docs_search`/`memory_search` make **one embedding call per
  query** (to embed the query string) plus the local ANN lookup. The "no cost when idle"
  promise holds; per-search there's a single round-trip (free against local Ollama).
- **Default recommendation:** point it at **Ollama** for the personal/offline case; the
  config lets a user flip to OpenAI for higher recall without code changes.

## 8. Open questions

1. ~~DuckDB vs Cozo~~ — **decided: DuckDB** (Cozo abandoned, last commit 2024).
   Remaining sub-question: recursive CTE vs `duckpgq` extension for traversal — spike CTE first.
2. ~~Embedding model~~ — **decided: remote OpenAI-compatible `/v1/embeddings`** (Ollama /
   OpenAI / gateway, config-swappable). See §10. Sub-question left: default model + dim
   (e.g. `nomic-embed-text` @ 768 for Ollama).
3. **Cross-root resolution in monorepos** — resolve `dst_name` within a root first,
   then across roots? Needs a precedence rule to avoid false call edges. (Compounded by
   §9: name collisions across files mean a bare `foo()` may resolve to several defs —
   manifest narrows it to present blobs, but same-name defs on one branch stay ambiguous;
   the optional typed tier disambiguates.)
4. **Uncommitted changes** — index the dirty working tree as synthetic blobs (accurate,
   more churn) vs. index only committed blobs (stale on dirty trees)? Lean synthetic.
5. **Manifest GC** — prune manifests/blobs for deleted branches on a schedule, or never
   (disk is cheap)?
6. **OpenCode workspace API** — confirm how the plugin discovers workspace roots
   (single vs multi-root) to populate `root`.
```
