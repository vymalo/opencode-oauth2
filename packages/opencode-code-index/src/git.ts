import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ManifestEntry } from "./types.js";

const execFileAsync = promisify(execFile);

/** Run a git command and return stdout. Injected in tests. */
export type GitRunner = (args: string[]) => Promise<string>;

/** Default runner: shells out to the `git` binary in `cwd`. */
export function makeGitRunner(cwd: string): GitRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  };
}

/**
 * A thin git facade over the seven calls the indexer needs. Content lookups go
 * through `git cat-file` by blob sha so any branch can be indexed without a
 * checkout (the content-addressed model — see docs/code-index.md).
 */
export class GitRepo {
  constructor(private readonly run: GitRunner) {}

  /** Confirm we are inside a work tree (false when git errors / not a repo). */
  async isRepo(): Promise<boolean> {
    try {
      const out = await this.run(["rev-parse", "--is-inside-work-tree"]);
      return out.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Stable repo identity = the (oldest) root-commit sha. Survives clones,
   * renames, and worktrees, so every branch/worktree maps to one index file.
   */
  async repoId(): Promise<string> {
    const out = await this.run(["rev-list", "--max-parents=0", "HEAD"]);
    const roots = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Multiple root commits (grafted/merged histories) — the last listed is the
    // oldest; pick it deterministically.
    return roots[roots.length - 1] ?? "unknown";
  }

  /** Current branch name, or the short HEAD sha when detached. */
  async currentBranch(): Promise<string> {
    const out = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (out && out !== "HEAD") {
      return out;
    }
    const sha = (await this.run(["rev-parse", "--short", "HEAD"])).trim();
    return sha || "HEAD";
  }

  /**
   * The `path -> blob` manifest for a ref (default HEAD), recursive, blobs only.
   * Uses NUL-delimited `ls-tree` so paths with spaces/newlines stay intact.
   */
  async lsTree(ref = "HEAD"): Promise<ManifestEntry[]> {
    const out = await this.run(["ls-tree", "-r", "-z", ref]);
    const entries: ManifestEntry[] = [];
    for (const record of out.split("\0")) {
      if (!record) {
        continue;
      }
      // `<mode> <type> <sha>\t<path>`
      const tab = record.indexOf("\t");
      if (tab < 0) {
        continue;
      }
      const meta = record.slice(0, tab).split(/\s+/);
      const type = meta[1];
      const blobSha = meta[2];
      if (type !== "blob" || !blobSha) {
        continue;
      }
      entries.push({ path: record.slice(tab + 1), blobSha });
    }
    return entries;
  }

  /** Read a blob's contents by sha. */
  async readBlob(blobSha: string): Promise<string> {
    return this.run(["cat-file", "blob", blobSha]);
  }
}
