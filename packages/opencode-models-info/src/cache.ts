import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CachedModelsRecord } from "./types.js";

function resolveDefaultCacheRoot(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches");
  }
  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

export function resolveCacheDir(namespace = "opencode-models-info"): string {
  return join(resolveDefaultCacheRoot(), namespace);
}

/**
 * Cache key = sha256(providerId :: url :: stableJSON(headers)).
 *
 * Only the **caller-specified** headers (i.e. `meta.modelsInfoHeaders`) go
 * into the key — NOT the provider's other request headers. Rationale: if a
 * rotating bearer (e.g. from `@vymalo/opencode-oauth2`) were keyed in, the
 * cache would thrash on every token refresh. Headers the user explicitly
 * configures for the metadata fetch (tenant selectors, static auth, etc.)
 * are exactly the ones that should bust the cache when they change.
 */
export function cacheKey(
  providerId: string,
  url: string,
  headers?: Record<string, string>
): string {
  const headerPart = headers ? stableStringify(headers) : "";
  return createHash("sha256").update(`${providerId}::${url}::${headerPart}`).digest("hex");
}

function stableStringify(headers: Record<string, string>): string {
  const sorted = Object.keys(headers)
    .sort()
    .map((k) => [k.toLowerCase(), headers[k]] as const);
  return JSON.stringify(sorted);
}

export interface CacheStore {
  get(key: string): Promise<CachedModelsRecord | undefined>;
  put(key: string, record: CachedModelsRecord): Promise<void>;
}

/**
 * Two-layer cache: an in-memory map for the process lifetime, backed by JSON
 * files on disk so cold starts reuse the last good snapshot. Disk writes are
 * atomic via rename-after-write so a crashed process can't leave a torn file.
 */
export class FileCacheStore implements CacheStore {
  private readonly memory = new Map<string, CachedModelsRecord>();
  private ready: Promise<void> | undefined;

  constructor(private readonly baseDir: string = resolveCacheDir()) {}

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(this.baseDir, { recursive: true, mode: 0o700 }).then(() => undefined);
    }
    await this.ready;
  }

  private filePath(key: string): string {
    return join(this.baseDir, `${key}.json`);
  }

  async get(key: string): Promise<CachedModelsRecord | undefined> {
    const memHit = this.memory.get(key);
    if (memHit) {
      return memHit;
    }
    try {
      await this.ensureReady();
      const raw = await readFile(this.filePath(key), "utf8");
      const parsed = JSON.parse(raw) as CachedModelsRecord;
      if (!isValidRecord(parsed)) {
        return undefined;
      }
      this.memory.set(key, parsed);
      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return undefined;
      }
      return undefined;
    }
  }

  async put(key: string, record: CachedModelsRecord): Promise<void> {
    this.memory.set(key, record);
    await this.ensureReady();
    const target = this.filePath(key);
    // Unique per-write temp name (pid + uuid) so concurrent opencode instances
    // — or two enrich passes in one process racing the same key — never collide
    // on the temp file and trip an ENOENT on rename. See opencode-oauth2's
    // saveServerState for the full rationale.
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
}

export function isExpired(record: CachedModelsRecord, now: number = Date.now()): boolean {
  return now - record.fetchedAt > record.ttlSeconds * 1000;
}

function isValidRecord(value: unknown): value is CachedModelsRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.fetchedAt === "number" &&
    typeof record.ttlSeconds === "number" &&
    Array.isArray(record.models)
  );
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "ENOENT"
  );
}
