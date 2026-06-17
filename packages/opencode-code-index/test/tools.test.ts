import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@opencode-ai/plugin";

import { resolveOptions } from "../src/config.js";
import { GitRepo, type GitRunner } from "../src/git.js";
import { CodeIndexStore } from "../src/store.js";
import { createCodeIndexTools, type ToolDeps } from "../src/tools.js";
import { chainState, type FakeGitState, fakeRunner } from "./fake-git.js";

const noopLogger: ToolDeps["logger"] = { debug() {}, info() {}, warn() {}, error() {} };

function buildTools(state: FakeGitState) {
  return createCodeIndexTools({
    options: resolveOptions({ dbPath: ":memory:" }),
    logger: noopLogger,
    openStore: () => CodeIndexStore.open(":memory:"),
    makeRepo: () => new GitRepo(fakeRunner(state))
  });
}

function run(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  worktree = "/repo"
): Promise<string> {
  const ctx = { worktree, abort: new AbortController().signal };
  return (tool as unknown as { execute: (a: unknown, c: unknown) => Promise<string> }).execute(
    args,
    ctx
  );
}

describe("code-index tools", () => {
  it("code_symbol locates a definition (lazily indexing on first touch)", async () => {
    const tools = buildTools(chainState("main"));
    const out = await run(tools.code_symbol, { name: "util" });
    expect(out).toContain("src/util.ts");
    expect(out).toContain("util");
  });

  it("code_callers lists callers", async () => {
    const tools = buildTools(chainState("main"));
    expect(await run(tools.code_callers, { name: "util" })).toContain("auth");
  });

  it("code_callees lists callees", async () => {
    const tools = buildTools(chainState("main"));
    expect(await run(tools.code_callees, { name: "handler" })).toContain("login");
  });

  it("code_references lists reference sites", async () => {
    const tools = buildTools(chainState("main"));
    const out = await run(tools.code_references, { name: "login" });
    expect(out).toContain("src/handler.ts");
  });

  it("code_blast_radius lists transitive dependents", async () => {
    const tools = buildTools(chainState("main"));
    const out = await run(tools.code_blast_radius, { name: "util" });
    expect(out).toContain("auth");
    expect(out).toContain("handler");
    expect(out).toContain("login");
  });

  it("rejects an empty name", async () => {
    const tools = buildTools(chainState("main"));
    expect(await run(tools.code_symbol, { name: "  " })).toContain("non-empty");
  });

  it("renders friendly empty-result messages", async () => {
    const tools = buildTools(chainState("main"));
    expect(await run(tools.code_symbol, { name: "ghost" })).toContain("No definition");
    expect(await run(tools.code_callers, { name: "handler" })).toContain("No callers");
    expect(await run(tools.code_callees, { name: "util" })).toContain("no resolved callees");
    expect(await run(tools.code_references, { name: "ghost" })).toContain("No references");
    expect(await run(tools.code_blast_radius, { name: "handler" })).toContain("Nothing depends");
  });

  it("index_status reports counts", async () => {
    const tools = buildTools(chainState("main"));
    const out = await run(tools.index_status, {});
    expect(out).toContain("files:");
    expect(out).toContain("symbols:");
  });

  it("index_refresh re-indexes the branch", async () => {
    const tools = buildTools(chainState("main"));
    const out = await run(tools.index_refresh, {});
    expect(out).toContain("Indexed branch");
    expect(out).toContain("main");
  });

  it("reports a friendly error outside a git work tree", async () => {
    const tools = buildTools({ branch: "main", tree: {}, blobs: {}, isRepo: false });
    await expect(run(tools.code_symbol, { name: "util" })).rejects.toThrow(/work tree/);
  });

  it("de-duplicates concurrent first-touch indexing (one run for parallel calls)", async () => {
    let lsTreeCalls = 0;
    const counting: GitRunner = async (args) => {
      if (args[0] === "ls-tree") lsTreeCalls++;
      return fakeRunner(chainState("main"))(args);
    };
    const tools = createCodeIndexTools({
      options: resolveOptions({ dbPath: ":memory:" }),
      logger: noopLogger,
      openStore: () => CodeIndexStore.open(":memory:"),
      makeRepo: () => new GitRepo(counting)
    });
    // Parallel tool calls on a fresh branch must share a single indexRepo run.
    const [a, b] = await Promise.all([
      run(tools.code_symbol, { name: "util" }),
      run(tools.code_callers, { name: "util" })
    ]);
    expect(a).toContain("util");
    expect(b).toContain("auth");
    expect(lsTreeCalls).toBe(1);
  });

  it("resolves a relative dbPath against the worktree, not the CWD", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "code-index-rel-"));
    let captured = "";
    const tools = createCodeIndexTools({
      options: resolveOptions({ dbPath: "sub/index.duckdb" }),
      logger: noopLogger,
      openStore: (path) => {
        captured = path;
        return CodeIndexStore.open(":memory:");
      },
      makeRepo: () => new GitRepo(fakeRunner(chainState("main")))
    });
    try {
      await run(tools.code_symbol, { name: "util" }, worktree);
      expect(captured).toBe(resolve(worktree, "sub/index.duckdb"));
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
