import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

import { SUPPORTED_EXTENSIONS } from "./extract.js";
import type { CodeIndexPluginOptions, ResolvedCodeIndexOptions } from "./types.js";

const NAMESPACE = "opencode-code-index";

/**
 * An env-provided base dir is only honored if it is an **absolute** path. An
 * empty or relative value (`??` doesn't catch `""`) would otherwise resolve the
 * cache under the process CWD — so fall back to the home-relative default.
 */
function envBase(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback;
}

/** Per-OS cache directory, mirroring the suite's cache-layout convention. */
export function cacheDir(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Caches", NAMESPACE);
    case "win32":
      return join(envBase(process.env.LOCALAPPDATA, join(home, "AppData", "Local")), NAMESPACE);
    default:
      return join(envBase(process.env.XDG_CACHE_HOME, join(home, ".cache")), NAMESPACE);
  }
}

/** Default DuckDB path for a repo: `<cache>/<repoId>.duckdb` (shared by all worktrees). */
export function defaultDbPath(repoId: string): string {
  return join(cacheDir(), `${repoId}.duckdb`);
}

export function resolveOptions(raw: CodeIndexPluginOptions | undefined): ResolvedCodeIndexOptions {
  const opts = raw ?? {};
  const extensions =
    Array.isArray(opts.extensions) && opts.extensions.length > 0
      ? opts.extensions.map((e) => e.replace(/^\./, "").toLowerCase())
      : [...SUPPORTED_EXTENSIONS];
  return {
    enabled: opts.enabled !== false,
    dbPath: typeof opts.dbPath === "string" && opts.dbPath.length > 0 ? opts.dbPath : undefined,
    extensions,
    autoIndex: opts.autoIndex === true
  };
}
