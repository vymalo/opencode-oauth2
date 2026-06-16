// Shared domain + option types for the code-index plugin.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Confidence in a resolved call edge — see docs/code-index.md §resolution. */
export type EdgeConfidence = "name" | "this" | "typed";

/** A symbol definition extracted from one blob. */
export interface SymbolDef {
  name: string;
  kind: "function" | "method" | "class";
  line: number;
}

/** A call/reference edge from an enclosing symbol to a referenced name. */
export interface RefEdge {
  /** Enclosing symbol name, or "<module>" for top-level references. */
  caller: string;
  /** The referenced name (unresolved — resolved at query time via the manifest). */
  dstName: string;
  kind: "call" | "new" | "method";
  line: number;
  confidence: EdgeConfidence;
}

/** Result of parsing one source blob. */
export interface Extraction {
  defs: SymbolDef[];
  refs: RefEdge[];
}

/** A `path -> blob` manifest entry for a branch/root. */
export interface ManifestEntry {
  path: string;
  blobSha: string;
}

/** A located symbol definition as returned by queries. */
export interface SymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
}

/** A located reference site as returned by queries. */
export interface RefHit {
  caller: string;
  path: string;
  line: number;
  kind: string;
  confidence: EdgeConfidence;
}

/** Index summary for `index_status`. */
export interface IndexStatus {
  branch: string;
  roots: string[];
  blobs: number;
  symbols: number;
  edges: number;
  files: number;
}

/** Raw plugin options as they arrive from OpenCode config. */
export interface CodeIndexPluginOptions {
  enabled?: boolean;
  /** Absolute or repo-relative path for the DuckDB file. Defaults under the cache dir. */
  dbPath?: string;
  /** File extensions to index (without the dot). Defaults to TS/JS family. */
  extensions?: string[];
  /** Auto-index on plugin load. Defaults to false (index on first tool use / explicit refresh). */
  autoIndex?: boolean;
}

export interface ResolvedCodeIndexOptions {
  enabled: boolean;
  dbPath: string | undefined;
  extensions: string[];
  autoIndex: boolean;
}
