import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";

import { defaultDbPath } from "./config.js";
import { GitRepo, makeGitRunner } from "./git.js";
import { indexRepo, type IndexResult } from "./indexer.js";
import type { Logger } from "./logging.js";
import { CodeIndexStore } from "./store.js";
import type { ResolvedCodeIndexOptions, SymbolHit } from "./types.js";

const z = tool.schema;

/** Open a store at `path` — injectable so tests use an in-memory DuckDB. */
export type OpenStore = (path: string) => Promise<CodeIndexStore>;
/** Build a GitRepo for a working directory — injectable in tests. */
export type MakeRepo = (cwd: string) => GitRepo;

export interface ToolDeps {
  options: ResolvedCodeIndexOptions;
  logger: Logger;
  openStore?: OpenStore;
  makeRepo?: MakeRepo;
}

interface WorktreeContext {
  repo: GitRepo;
  store: CodeIndexStore;
  dbPath: string;
  /** Branches already indexed (or confirmed indexed) in this process. */
  ensured: Set<string>;
  /** In-flight indexing promise per branch, so concurrent tool calls share one run. */
  indexing: Map<string, Promise<IndexResult>>;
}

const NOT_A_REPO = "code-index: not inside a git work tree — nothing to index.";

function locLine(h: SymbolHit): string {
  return `  ${h.path}:${h.line}  ${h.name} (${h.kind})`;
}

const STRUCTURAL_NOTE =
  "\n(structural graph — free-function/ctor/this edges; cross-object method dispatch may be missing.)";

/**
 * Build the `code_*` / `index_*` tools. Each tool resolves a per-worktree
 * DuckDB context (lazily indexing the current branch on first touch), runs a
 * structural query, and renders text. The graph is content-addressed and
 * branch-scoped, so answers track the branch the tool is invoked from.
 */
export function createCodeIndexTools(deps: ToolDeps): Record<string, ToolDefinition> {
  const openStore: OpenStore = deps.openStore ?? ((path) => CodeIndexStore.open(path));
  const makeRepo: MakeRepo = deps.makeRepo ?? ((cwd) => new GitRepo(makeGitRunner(cwd)));
  const contexts = new Map<string, Promise<WorktreeContext>>();

  async function buildContext(worktree: string): Promise<WorktreeContext> {
    const repo = makeRepo(worktree);
    if (!(await repo.isRepo())) {
      throw new Error(NOT_A_REPO);
    }
    const repoId = await repo.repoId();
    let dbPath = deps.options.dbPath ?? defaultDbPath(repoId);
    if (dbPath !== ":memory:") {
      // A relative override resolves against the worktree, not the process CWD
      // (which is undefined for a plugin and varies per session).
      if (!isAbsolute(dbPath)) {
        dbPath = resolve(worktree, dbPath);
      }
      await mkdir(dirname(dbPath), { recursive: true });
    }
    const store = await openStore(dbPath);
    return { repo, store, dbPath, ensured: new Set(), indexing: new Map() };
  }

  function context(worktree: string): Promise<WorktreeContext> {
    let pending = contexts.get(worktree);
    if (!pending) {
      pending = buildContext(worktree);
      contexts.set(worktree, pending);
      // Drop a failed context so a later call can retry (e.g. repo appears).
      pending.catch(() => contexts.delete(worktree));
    }
    return pending;
  }

  /**
   * Run `indexRepo` for a branch, de-duplicating concurrent calls. OpenCode runs
   * tools in parallel, so two calls landing in the same window must share one run
   * (else duplicate INSERTs / lock contention). The promise is cleared on
   * completion, so a *later* call always triggers a fresh (incremental) run.
   */
  function startIndex(ctx: WorktreeContext, branch: string): Promise<IndexResult> {
    let pending = ctx.indexing.get(branch);
    if (!pending) {
      pending = indexRepo(ctx.repo, ctx.store, {
        extensions: deps.options.extensions,
        logger: deps.logger
      }).finally(() => ctx.indexing.delete(branch));
      ctx.indexing.set(branch, pending);
    }
    return pending;
  }

  /** Ensure the current branch is indexed once per process; returns the branch. */
  async function ensureIndexed(ctx: WorktreeContext): Promise<string> {
    const branch = await ctx.repo.currentBranch();
    if (ctx.ensured.has(branch)) {
      return branch;
    }
    const status = await ctx.store.status(branch);
    if (status.files === 0) {
      await startIndex(ctx, branch);
    }
    ctx.ensured.add(branch);
    return branch;
  }

  const nameArg = { name: z.string().describe("Symbol name (function / method / class).") };

  function nameTool(
    description: string,
    run: (ctx: WorktreeContext, name: string, branch: string) => Promise<string>
  ): ToolDefinition {
    return {
      description,
      args: nameArg,
      async execute(args: Record<string, unknown>, toolCtx: ToolContext) {
        const name = String(args.name ?? "").trim();
        if (!name) {
          return "code-index: provide a non-empty `name`.";
        }
        const ctx = await context(toolCtx.worktree);
        const branch = await ensureIndexed(ctx);
        return run(ctx, name, branch);
      }
    } as unknown as ToolDefinition;
  }

  const tools: Record<string, ToolDefinition> = {
    code_symbol: nameTool(
      "Find where a symbol is defined (file:line) on the current branch.",
      async (ctx, name, branch) => {
        const hits = await ctx.store.symbol(name, branch);
        if (hits.length === 0) {
          return `No definition of \`${name}\` on branch \`${branch}\`.`;
        }
        return `Definition(s) of \`${name}\` on \`${branch}\`:\n${hits.map(locLine).join("\n")}`;
      }
    ),

    code_callers: nameTool(
      "List the symbols that directly call/reference a symbol.",
      async (ctx, name, branch) => {
        const hits = await ctx.store.callers(name, branch);
        if (hits.length === 0) {
          return `No callers of \`${name}\` found on \`${branch}\`.${STRUCTURAL_NOTE}`;
        }
        return `Callers of \`${name}\` on \`${branch}\` (${hits.length}):\n${hits.map(locLine).join("\n")}${STRUCTURAL_NOTE}`;
      }
    ),

    code_callees: nameTool(
      "List the symbols a symbol directly calls.",
      async (ctx, name, branch) => {
        const hits = await ctx.store.callees(name, branch);
        if (hits.length === 0) {
          return `\`${name}\` has no resolved callees on \`${branch}\`.${STRUCTURAL_NOTE}`;
        }
        return `Callees of \`${name}\` on \`${branch}\` (${hits.length}):\n${hits.map(locLine).join("\n")}${STRUCTURAL_NOTE}`;
      }
    ),

    code_references: nameTool(
      "List every reference site (file:line) pointing at a symbol.",
      async (ctx, name, branch) => {
        const hits = await ctx.store.references(name, branch);
        if (hits.length === 0) {
          return `No references to \`${name}\` on \`${branch}\`.`;
        }
        const lines = hits.map(
          (h) => `  ${h.path}:${h.line}  in ${h.caller} [${h.kind}/${h.confidence}]`
        );
        return `References to \`${name}\` on \`${branch}\` (${hits.length}):\n${lines.join("\n")}`;
      }
    ),

    code_blast_radius: nameTool(
      "Transitive dependents of a symbol — everything that (in)directly depends on it.",
      async (ctx, name, branch) => {
        const deps2 = await ctx.store.blastRadius(name, branch);
        if (deps2.length === 0) {
          return `Nothing depends on \`${name}\` on \`${branch}\`.${STRUCTURAL_NOTE}`;
        }
        return `Blast radius of \`${name}\` on \`${branch}\` (${deps2.length}):\n  ${deps2.join(", ")}${STRUCTURAL_NOTE}`;
      }
    ),

    index_refresh: {
      description: "Re-index the current branch (incremental — only changed blobs are parsed).",
      args: {},
      async execute(_args: Record<string, unknown>, toolCtx: ToolContext) {
        const ctx = await context(toolCtx.worktree);
        const branch = await ctx.repo.currentBranch();
        const result = await startIndex(ctx, branch);
        ctx.ensured.add(branch);
        return `Indexed branch \`${result.branch}\`: ${result.indexedBlobs} new blob(s), ${result.skippedBlobs} reused, ${result.files} file(s).`;
      }
    } as unknown as ToolDefinition,

    index_status: {
      description: "Show the code index status (branch, file/symbol/edge counts).",
      args: {},
      async execute(_args: Record<string, unknown>, toolCtx: ToolContext) {
        const ctx = await context(toolCtx.worktree);
        const branch = await ensureIndexed(ctx);
        const s = await ctx.store.status(branch);
        return [
          `Code index for branch \`${s.branch}\` (db: ${ctx.dbPath}):`,
          `  files:   ${s.files}`,
          `  blobs:   ${s.blobs} (total pool across branches)`,
          `  symbols: ${s.symbols}`,
          `  edges:   ${s.edges}`,
          `  roots:   ${s.roots.join(", ") || "."}`
        ].join("\n");
      }
    } as unknown as ToolDefinition
  };

  return tools;
}
