import { afterEach, describe, expect, it } from "vitest";

import { GitRepo } from "../src/git.js";
import { indexRepo } from "../src/indexer.js";
import { CodeIndexStore } from "../src/store.js";
import { chainState, fakeRunner } from "./fake-git.js";

const EXTS = ["ts", "tsx", "js", "jsx"];

let store: CodeIndexStore;
afterEach(() => store?.close());

describe("indexRepo", () => {
  it("indexes the HEAD tree end-to-end and builds a queryable graph", async () => {
    store = await CodeIndexStore.open(":memory:");
    const repo = new GitRepo(fakeRunner(chainState("main")));

    const result = await indexRepo(repo, store, { extensions: EXTS });

    expect(result.branch).toBe("main");
    expect(result.files).toBe(4); // 4 .ts files; README.md excluded
    expect(result.indexedBlobs).toBe(4);
    expect(result.skippedBlobs).toBe(0);

    // The real tree-sitter extraction + DuckDB resolution produces the chain.
    expect(await store.blastRadius("util", "main")).toEqual(["auth", "handler", "login"]);
    expect((await store.symbol("handler", "main"))[0]?.path).toBe("src/handler.ts");
  });

  it("excludes non-code files from the manifest", async () => {
    store = await CodeIndexStore.open(":memory:");
    const repo = new GitRepo(fakeRunner(chainState("main")));
    await indexRepo(repo, store, { extensions: EXTS });
    const status = await store.status("main");
    expect(status.files).toBe(4); // README.md not counted
  });

  it("reuses unchanged blobs across a branch switch (delta only)", async () => {
    store = await CodeIndexStore.open(":memory:");
    const state = chainState("main");
    const repo = new GitRepo(fakeRunner(state));

    await indexRepo(repo, store, { extensions: EXTS });

    // Switch to the feature branch: only src/auth.ts changes (authA -> authB).
    Object.assign(state, chainState("feature"));
    const second = await indexRepo(repo, store, { extensions: EXTS });

    expect(second.branch).toBe("feature");
    expect(second.indexedBlobs).toBe(1); // only authB is new
    expect(second.skippedBlobs).toBe(3); // util/login/handler reused

    // Same blob pool, different manifest => different blast radius.
    expect(await store.blastRadius("util", "main")).toEqual(["auth", "handler", "login"]);
    expect(await store.blastRadius("util", "feature")).toEqual([]);
    expect(await store.blastRadius("auth", "feature")).toEqual(["handler", "login"]);
  });

  it("logs (does not crash on) a fallback write failure after a read error", async () => {
    const errors: string[] = [];
    const repo = new GitRepo(fakeRunner({ branch: "main", tree: { "bad.ts": "x" }, blobs: {} }));
    // A store whose writes always fail — the read fails first, then the empty
    // fallback insert fails too; both are logged and indexing continues.
    const failStore = {
      hasBlob: async () => false,
      insertBlob: async () => {
        throw new Error("disk full");
      },
      replaceManifest: async () => {}
    } as unknown as CodeIndexStore;
    const result = await indexRepo(repo, failStore, {
      extensions: EXTS,
      logger: { debug() {}, info() {}, warn() {}, error: (e) => errors.push(e) }
    });
    expect(errors).toContain("code_index_fallback_write_failed");
    expect(result.files).toBe(1);
  });

  it("records a blob with no symbols when extraction throws", async () => {
    store = await CodeIndexStore.open(":memory:");
    const warns: string[] = [];
    const repo = new GitRepo(
      fakeRunner({
        branch: "main",
        tree: { "bad.ts": "badsha" },
        // readBlob throws for an unknown sha -> indexer should swallow + record empty
        blobs: {}
      })
    );
    const result = await indexRepo(repo, store, {
      extensions: EXTS,
      logger: {
        debug() {},
        info() {},
        warn: (e) => warns.push(e),
        error() {}
      }
    });
    expect(result.files).toBe(1);
    expect(warns).toContain("code_index_blob_failed");
    expect(await store.hasBlob("badsha")).toBe(true); // recorded so it won't retry
  });
});
