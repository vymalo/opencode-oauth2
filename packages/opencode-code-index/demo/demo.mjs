// Live demo of @vymalo/opencode-code-index against THIS repo.
//
//   pnpm --filter @vymalo/opencode-code-index build   # emit dist/
//   node packages/opencode-code-index/demo/demo.mjs
//
// It indexes the current branch's HEAD tree into a throwaway DuckDB file and
// drives the real `code_*` tools exactly as OpenCode would, printing the text
// the model receives. No cache pollution: the db lives in the OS temp dir and
// is removed at the end.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodeIndexTools, resolveOptions } from "../dist/lib.js";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const dbPath = join(tmpdir(), "code-index-demo.duckdb");
rmSync(dbPath, { force: true });

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const tools = createCodeIndexTools({
  options: resolveOptions({ dbPath }),
  logger: noopLogger
});

const ctx = { worktree: repoRoot, abort: new AbortController().signal };
const call = async (name, args = {}) => {
  const out = await tools[name].execute(args, ctx);
  console.log(`\n▶ ${name}(${JSON.stringify(args)})`);
  console.log(typeof out === "string" ? out : out.output);
};

try {
  console.log(`Indexing ${repoRoot} …`);
  await call("index_refresh"); // build the index for the current branch
  await call("index_status");
  await call("code_symbol", { name: "CodeIndexStore" });
  await call("code_callees", { name: "indexRepo" });
  await call("code_callers", { name: "extractFromSource" });
  await call("code_references", { name: "extractFromSource" });
  await call("code_blast_radius", { name: "extractFromSource" });
} finally {
  rmSync(dbPath, { force: true });
}
