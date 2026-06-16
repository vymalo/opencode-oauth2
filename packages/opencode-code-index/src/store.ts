import {
  type DuckDBConnection,
  type DuckDBInstance,
  DuckDBInstance as Instance
} from "@duckdb/node-api";

import type { Extraction, IndexStatus, ManifestEntry, RefHit, SymbolHit } from "./types.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS blob (
     blob_sha TEXT PRIMARY KEY,
     lang     TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS symbol (
     blob_sha TEXT,
     name     TEXT,
     kind     TEXT,
     line     INTEGER
   );`,
  // A call/reference edge. `dst_name` is intentionally UNRESOLVED — it is
  // resolved against the active branch manifest at query time (content-addressed
  // model: an edge is valid on every branch where both blobs are present).
  `CREATE TABLE IF NOT EXISTS ref (
     src_blob   TEXT,
     caller     TEXT,
     dst_name   TEXT,
     kind       TEXT,
     line       INTEGER,
     confidence TEXT
   );`,
  // The only per-branch state: which blob sits at which path. `root` carries the
  // workspace root for forward-compat with multi-root indexing (single "." today).
  `CREATE TABLE IF NOT EXISTS manifest (
     branch   TEXT,
     root     TEXT,
     path     TEXT,
     blob_sha TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol(name);`,
  `CREATE INDEX IF NOT EXISTS idx_ref_dst ON ref(dst_name);`,
  `CREATE INDEX IF NOT EXISTS idx_ref_caller ON ref(caller);`,
  `CREATE INDEX IF NOT EXISTS idx_manifest_branch ON manifest(branch, blob_sha);`
];

const MODULE = "<module>";

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : (value as number);
}

/**
 * The DuckDB-backed code index. Holds blobs/symbols/refs (content-addressed,
 * branch-independent) plus a per-branch manifest, and answers the structural
 * queries by resolving names against the active manifest. See docs/code-index.md.
 */
export class CodeIndexStore {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection
  ) {}

  /** Open (or create) the index at `path`, or ":memory:" for an ephemeral store. */
  static async open(path: string): Promise<CodeIndexStore> {
    const instance = await Instance.create(path);
    const conn = await instance.connect();
    for (const ddl of SCHEMA) {
      await conn.run(ddl);
    }
    return new CodeIndexStore(instance, conn);
  }

  close(): void {
    try {
      this.conn.closeSync();
    } catch {
      /* best-effort */
    }
    try {
      this.instance.closeSync();
    } catch {
      /* best-effort */
    }
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const reader = await this.conn.runAndReadAll(sql, params as never);
    return reader.getRowObjects() as Record<string, unknown>[];
  }

  async hasBlob(blobSha: string): Promise<boolean> {
    const r = await this.rows("SELECT 1 FROM blob WHERE blob_sha = ? LIMIT 1", [blobSha]);
    return r.length > 0;
  }

  /** Insert a parsed blob (blob row + its symbols + its edges) in one shot. */
  async insertBlob(blobSha: string, lang: string, extraction: Extraction): Promise<void> {
    await this.conn.run("INSERT INTO blob VALUES (?, ?)", [blobSha, lang]);
    for (const d of extraction.defs) {
      await this.conn.run("INSERT INTO symbol VALUES (?, ?, ?, ?)", [
        blobSha,
        d.name,
        d.kind,
        d.line
      ]);
    }
    for (const e of extraction.refs) {
      await this.conn.run("INSERT INTO ref VALUES (?, ?, ?, ?, ?, ?)", [
        blobSha,
        e.caller,
        e.dstName,
        e.kind,
        e.line,
        e.confidence
      ]);
    }
  }

  /** Replace a branch/root's manifest with `entries` (delete-then-insert). */
  async replaceManifest(branch: string, root: string, entries: ManifestEntry[]): Promise<void> {
    await this.conn.run("DELETE FROM manifest WHERE branch = ? AND root = ?", [branch, root]);
    for (const e of entries) {
      await this.conn.run("INSERT INTO manifest VALUES (?, ?, ?, ?)", [
        branch,
        root,
        e.path,
        e.blobSha
      ]);
    }
  }

  /** Definitions of `name` present on `branch`. */
  async symbol(name: string, branch: string): Promise<SymbolHit[]> {
    const rows = await this.rows(
      `SELECT s.name, s.kind, m.path AS path, s.line
       FROM symbol s
       JOIN manifest m ON m.branch = ? AND m.blob_sha = s.blob_sha
       WHERE s.name = ?
       ORDER BY path, s.line`,
      [branch, name]
    );
    return rows.map((r) => ({
      name: r.name as string,
      kind: r.kind as string,
      path: r.path as string,
      line: num(r.line)
    }));
  }

  /** Symbols that directly call `name` on `branch`. */
  async callers(name: string, branch: string): Promise<SymbolHit[]> {
    const rows = await this.rows(
      `SELECT DISTINCT s.name, s.kind, mfs.path AS path, s.line
       FROM ref r
       JOIN manifest mfs ON mfs.branch = ? AND mfs.blob_sha = r.src_blob
       JOIN symbol   s   ON s.blob_sha = r.src_blob AND s.name = r.caller
       JOIN symbol   sd  ON sd.name = r.dst_name
       JOIN manifest mfd ON mfd.branch = ? AND mfd.blob_sha = sd.blob_sha
       WHERE r.dst_name = ? AND r.caller <> '${MODULE}'
       ORDER BY path, s.line`,
      [branch, branch, name]
    );
    return rows.map((r) => ({
      name: r.name as string,
      kind: r.kind as string,
      path: r.path as string,
      line: num(r.line)
    }));
  }

  /** Symbols directly called by `name` on `branch`. */
  async callees(name: string, branch: string): Promise<SymbolHit[]> {
    const rows = await this.rows(
      `SELECT DISTINCT sd.name, sd.kind, mfd.path AS path, sd.line
       FROM ref r
       JOIN manifest mfs ON mfs.branch = ? AND mfs.blob_sha = r.src_blob
       JOIN symbol   sd  ON sd.name = r.dst_name
       JOIN manifest mfd ON mfd.branch = ? AND mfd.blob_sha = sd.blob_sha
       WHERE r.caller = ?
       ORDER BY path, sd.line`,
      [branch, branch, name]
    );
    return rows.map((r) => ({
      name: r.name as string,
      kind: r.kind as string,
      path: r.path as string,
      line: num(r.line)
    }));
  }

  /** All resolved reference sites pointing at `name` on `branch`. */
  async references(name: string, branch: string): Promise<RefHit[]> {
    const rows = await this.rows(
      `SELECT r.caller AS caller, mfs.path AS path, r.line AS line, r.kind AS kind, r.confidence AS confidence
       FROM ref r
       JOIN manifest mfs ON mfs.branch = ? AND mfs.blob_sha = r.src_blob
       JOIN symbol   sd  ON sd.name = r.dst_name
       JOIN manifest mfd ON mfd.branch = ? AND mfd.blob_sha = sd.blob_sha
       WHERE r.dst_name = ?
       ORDER BY path, line`,
      [branch, branch, name]
    );
    return rows.map((r) => ({
      caller: r.caller as string,
      path: r.path as string,
      line: num(r.line),
      kind: r.kind as string,
      confidence: r.confidence as RefHit["confidence"]
    }));
  }

  /** Transitive dependents of `name` on `branch` (the blast radius). */
  async blastRadius(name: string, branch: string): Promise<string[]> {
    const rows = await this.rows(
      `WITH RECURSIVE active(caller, callee) AS (
         SELECT r.caller, r.dst_name
         FROM ref r
         JOIN manifest mfs ON mfs.branch = ? AND mfs.blob_sha = r.src_blob
         JOIN symbol   sd  ON sd.name = r.dst_name
         JOIN manifest mfd ON mfd.branch = ? AND mfd.blob_sha = sd.blob_sha
       ),
       deps(sym) AS (
         SELECT caller FROM active WHERE callee = ? AND caller <> '${MODULE}'
         UNION
         SELECT a.caller FROM active a JOIN deps d ON a.callee = d.sym WHERE a.caller <> '${MODULE}'
       )
       SELECT sym FROM deps ORDER BY sym`,
      [branch, branch, name]
    );
    return rows.map((r) => r.sym as string);
  }

  /** Index totals + the file count for `branch`. */
  async status(branch: string): Promise<IndexStatus> {
    const one = async (sql: string, params: unknown[] = []) =>
      num((await this.rows(sql, params))[0]?.n);
    const blobs = await one("SELECT count(*) AS n FROM blob");
    const symbols = await one("SELECT count(*) AS n FROM symbol");
    const edges = await one("SELECT count(*) AS n FROM ref");
    const files = await one("SELECT count(*) AS n FROM manifest WHERE branch = ?", [branch]);
    const rootRows = await this.rows(
      "SELECT DISTINCT root FROM manifest WHERE branch = ? ORDER BY root",
      [branch]
    );
    return {
      branch,
      roots: rootRows.map((r) => r.root as string),
      blobs,
      symbols,
      edges,
      files
    };
  }
}
