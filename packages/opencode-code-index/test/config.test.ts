import { describe, expect, it } from "vitest";

import { cacheDir, defaultDbPath, resolveOptions } from "../src/config.js";
import { SUPPORTED_EXTENSIONS } from "../src/extract.js";

describe("resolveOptions", () => {
  it("applies defaults", () => {
    const o = resolveOptions(undefined);
    expect(o.enabled).toBe(true);
    expect(o.autoIndex).toBe(false);
    expect(o.dbPath).toBeUndefined();
    expect(o.extensions).toEqual([...SUPPORTED_EXTENSIONS]);
  });

  it("normalizes custom extensions (strips dots, lowercases)", () => {
    expect(resolveOptions({ extensions: [".TS", "Mjs"] }).extensions).toEqual(["ts", "mjs"]);
  });

  it("honors explicit enabled/dbPath/autoIndex", () => {
    const o = resolveOptions({ enabled: false, dbPath: "/tmp/x.duckdb", autoIndex: true });
    expect(o.enabled).toBe(false);
    expect(o.dbPath).toBe("/tmp/x.duckdb");
    expect(o.autoIndex).toBe(true);
  });
});

describe("paths", () => {
  it("derives a per-repo db path under the cache dir", () => {
    const p = defaultDbPath("abc123");
    expect(p.startsWith(cacheDir())).toBe(true);
    expect(p.endsWith("abc123.duckdb")).toBe(true);
  });
});
