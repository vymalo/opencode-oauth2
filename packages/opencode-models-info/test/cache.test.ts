import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cacheKey, FileCacheStore, isExpired } from "../src/cache.js";
import type { CachedModelsRecord } from "../src/types.js";

describe("FileCacheStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-models-info-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (now: number): CachedModelsRecord => ({
    fetchedAt: now,
    ttlSeconds: 60,
    etag: "abc",
    models: [{ id: "model-a", context_length: 1024 }]
  });

  it("round-trips through disk and serves from memory on second read", async () => {
    const store = new FileCacheStore(dir);
    const key = cacheKey("p", "https://example.test/models");
    const record = sample(1000);

    await store.put(key, record);
    const fromDisk = await store.get(key);
    expect(fromDisk).toEqual(record);

    const onDisk = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8"));
    expect(onDisk.fetchedAt).toBe(1000);

    const fromMem = await store.get(key);
    expect(fromMem).toEqual(record);
  });

  it("returns undefined on cache miss", async () => {
    const store = new FileCacheStore(dir);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("survives garbage on disk by returning undefined", async () => {
    const store = new FileCacheStore(dir);
    const key = cacheKey("p", "https://example.test/models");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `${key}.json`), "{not json", { mode: 0o600 });
    expect(await store.get(key)).toBeUndefined();
  });
});

describe("isExpired", () => {
  it("returns false within the TTL window", () => {
    const record: CachedModelsRecord = {
      fetchedAt: 1_000_000,
      ttlSeconds: 60,
      models: []
    };
    expect(isExpired(record, 1_000_000 + 30_000)).toBe(false);
  });

  it("returns true past the TTL window", () => {
    const record: CachedModelsRecord = {
      fetchedAt: 1_000_000,
      ttlSeconds: 60,
      models: []
    };
    expect(isExpired(record, 1_000_000 + 61_000)).toBe(true);
  });
});

describe("cacheKey", () => {
  it("is deterministic and namespace-isolated per provider/url pair", () => {
    expect(cacheKey("a", "u")).toBe(cacheKey("a", "u"));
    expect(cacheKey("a", "u")).not.toBe(cacheKey("b", "u"));
    expect(cacheKey("a", "u")).not.toBe(cacheKey("a", "u2"));
  });
});
