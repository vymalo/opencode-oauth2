import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { CachedServerState } from "./types.js";

function resolveDefaultCacheRoot(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches");
  }

  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

export function resolveCacheDir(namespace: string): string {
  return join(resolveDefaultCacheRoot(), "lightbridge-opencode", namespace);
}

function statePath(baseDir: string, serverId: string): string {
  return join(baseDir, `${serverId}.json`);
}

function hasValidTokenShape(token: unknown): boolean {
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    return false;
  }

  const candidate = token as Record<string, unknown>;
  if (
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0 ||
    typeof candidate.tokenType !== "string" ||
    candidate.tokenType.length === 0
  ) {
    return false;
  }

  // refreshToken is optional: client_credentials grant never returns one.
  // When present, it must be a non-empty string.
  if (candidate.refreshToken !== undefined) {
    return typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0;
  }
  return true;
}

export class FileCacheStore {
  constructor(private readonly baseDir: string) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  async loadServerState(serverId: string): Promise<CachedServerState | undefined> {
    const filePath = statePath(this.baseDir, serverId);

    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as CachedServerState;

      if (!parsed || parsed.serverId !== serverId) {
        return undefined;
      }

      if (!Array.isArray(parsed.models) || !Array.isArray(parsed.rawModels)) {
        return undefined;
      }

      if (parsed.token && !hasValidTokenShape(parsed.token)) {
        parsed.token = undefined;
      }

      return parsed;
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async saveServerState(state: CachedServerState): Promise<void> {
    const filePath = statePath(this.baseDir, state.serverId);
    const tempPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

    const serialized = JSON.stringify(state, null, 2);
    await writeFile(tempPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY
    });

    await rename(tempPath, filePath);

    try {
      await chmod(filePath, 0o600);
    } catch {
      // Some filesystems may ignore chmod semantics; keep operation non-fatal.
    }
  }
}
