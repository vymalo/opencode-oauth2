import { extname } from "node:path";

import { extractFromSource } from "./extract.js";
import type { GitRepo } from "./git.js";
import type { Logger } from "./logging.js";
import type { CodeIndexStore } from "./store.js";
import type { ManifestEntry } from "./types.js";

export interface IndexOptions {
  extensions: string[];
  root?: string;
  logger?: Logger;
}

export interface IndexResult {
  branch: string;
  root: string;
  indexedBlobs: number;
  skippedBlobs: number;
  files: number;
}

function extOf(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

/**
 * Index the current branch's HEAD tree into the store. Blob-delta: a blob
 * already present (from any branch/worktree) is skipped, so a branch switch only
 * pays for changed files. Rewrites the branch manifest at the end.
 */
export async function indexRepo(
  repo: GitRepo,
  store: CodeIndexStore,
  options: IndexOptions
): Promise<IndexResult> {
  const root = options.root ?? ".";
  const exts = new Set(options.extensions.map((e) => e.toLowerCase()));
  const branch = await repo.currentBranch();
  const entries = await repo.lsTree("HEAD");

  const indexable: ManifestEntry[] = entries.filter((e) => exts.has(extOf(e.path)));

  let indexed = 0;
  let skipped = 0;
  const processed = new Set<string>(); // within-run blob dedup (same blob, many paths)

  for (const entry of indexable) {
    if (processed.has(entry.blobSha)) {
      continue;
    }
    processed.add(entry.blobSha);

    if (await store.hasBlob(entry.blobSha)) {
      skipped++;
      continue;
    }

    const lang = extOf(entry.path);
    try {
      const source = await repo.readBlob(entry.blobSha);
      const extraction = extractFromSource(source, lang);
      await store.insertBlob(entry.blobSha, lang, extraction);
      indexed++;
    } catch (err) {
      // Record the blob with no symbols so we don't retry a file we can't parse.
      await store.insertBlob(entry.blobSha, lang, { defs: [], refs: [] });
      options.logger?.warn("code_index_blob_failed", {
        path: entry.path,
        blob: entry.blobSha,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  await store.replaceManifest(branch, root, indexable);

  options.logger?.info("code_index_indexed", {
    branch,
    root,
    indexed,
    skipped,
    files: indexable.length
  });

  return { branch, root, indexedBlobs: indexed, skippedBlobs: skipped, files: indexable.length };
}
