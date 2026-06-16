import { describe, expect, it } from "vitest";

import { GitRepo, makeGitRunner } from "../src/git.js";
import { fakeRunner } from "./fake-git.js";

describe("makeGitRunner", () => {
  it("shells out to the real git binary in this repo", async () => {
    const run = makeGitRunner(process.cwd());
    expect((await run(["rev-parse", "--is-inside-work-tree"])).trim()).toBe("true");
  });
});

describe("GitRepo", () => {
  it("detects a work tree", async () => {
    const repo = new GitRepo(fakeRunner({ branch: "main", tree: {}, blobs: {} }));
    expect(await repo.isRepo()).toBe(true);
  });

  it("reports not-a-repo when git errors or says false", async () => {
    const off = new GitRepo(fakeRunner({ branch: "main", tree: {}, blobs: {}, isRepo: false }));
    expect(await off.isRepo()).toBe(false);
    const throwing = new GitRepo(async () => {
      throw new Error("not a git repo");
    });
    expect(await throwing.isRepo()).toBe(false);
  });

  it("picks the oldest root commit as the repo id", async () => {
    const repo = new GitRepo(async (args) => {
      if (args[0] === "rev-list") return "newroot\noldroot\n";
      throw new Error("x");
    });
    expect(await repo.repoId()).toBe("oldroot");
  });

  it("returns the branch name, falling back to short sha when detached", async () => {
    const onBranch = new GitRepo(fakeRunner({ branch: "feature/x", tree: {}, blobs: {} }));
    expect(await onBranch.currentBranch()).toBe("feature/x");
    const detached = new GitRepo(fakeRunner({ branch: "HEAD", tree: {}, blobs: {} }));
    expect(await detached.currentBranch()).toBe("abcdef0");
  });

  it("parses ls-tree into blob manifest entries, skipping non-blobs", async () => {
    const records = [
      "100644 blob sha1\tsrc/a.ts",
      "040000 tree shaT\tsrc",
      "100644 blob sha2\tb.ts"
    ];
    const repo = new GitRepo(async (args) => {
      if (args[0] === "ls-tree") {
        return `${records.join("\0")}\0`;
      }
      throw new Error("x");
    });
    const entries = await repo.lsTree("HEAD");
    expect(entries).toEqual([
      { path: "src/a.ts", blobSha: "sha1" },
      { path: "b.ts", blobSha: "sha2" }
    ]);
  });

  it("reads blob contents by sha", async () => {
    const repo = new GitRepo(fakeRunner({ branch: "main", tree: {}, blobs: { s: "hello" } }));
    expect(await repo.readBlob("s")).toBe("hello");
    await expect(repo.readBlob("missing")).rejects.toThrow();
  });
});
