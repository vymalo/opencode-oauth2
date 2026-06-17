import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodeIndexStore } from "../src/store.js";
import type { Extraction } from "../src/types.js";

const def = (name: string): Extraction["defs"][number] => ({ name, kind: "function", line: 1 });
const call = (caller: string, dstName: string): Extraction["refs"][number] => ({
  caller,
  dstName,
  kind: "call",
  line: 2,
  confidence: "name"
});

let store: CodeIndexStore;

// Shared call chain: handler -> login -> auth -> util.
// main uses authA (auth -> util); feature uses authB (auth refactored, no util).
beforeEach(async () => {
  store = await CodeIndexStore.open(":memory:");
  await store.insertBlob("util", "ts", { defs: [def("util")], refs: [] });
  await store.insertBlob("authA", "ts", { defs: [def("auth")], refs: [call("auth", "util")] });
  await store.insertBlob("authB", "ts", { defs: [def("auth")], refs: [] });
  await store.insertBlob("login", "ts", { defs: [def("login")], refs: [call("login", "auth")] });
  await store.insertBlob("handler", "ts", {
    defs: [def("handler")],
    refs: [call("handler", "login"), call("<module>", "login")]
  });
  const common = [
    { path: "util.ts", blobSha: "util" },
    { path: "login.ts", blobSha: "login" },
    { path: "handler.ts", blobSha: "handler" }
  ];
  await store.replaceManifest("main", ".", [...common, { path: "auth.ts", blobSha: "authA" }]);
  await store.replaceManifest("feature", ".", [...common, { path: "auth.ts", blobSha: "authB" }]);
});

afterEach(() => store.close());

describe("blastRadius", () => {
  it("resolves transitively through the active branch manifest", async () => {
    expect(await store.blastRadius("util", "main")).toEqual(["auth", "handler", "login"]);
  });

  it("returns empty when the refactored branch severs the edge", async () => {
    expect(await store.blastRadius("util", "feature")).toEqual([]);
  });

  it("keeps the rest of the chain intact on the refactored branch", async () => {
    expect(await store.blastRadius("auth", "feature")).toEqual(["handler", "login"]);
  });
});

describe("callers / callees", () => {
  it("lists direct callers, excluding <module>-level references", async () => {
    expect((await store.callers("util", "main")).map((h) => h.name)).toEqual(["auth"]);
    // handler calls login at both function and module scope; only the function counts.
    expect((await store.callers("login", "main")).map((h) => h.name)).toEqual(["handler"]);
  });

  it("lists direct callees", async () => {
    expect((await store.callees("handler", "main")).map((h) => h.name)).toEqual(["login"]);
    expect(await store.callees("util", "main")).toEqual([]);
  });
});

describe("references", () => {
  it("returns every reference site including module-level ones", async () => {
    const refs = await store.references("login", "main");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.caller).sort()).toEqual(["<module>", "handler"]);
    expect(refs[0]).toHaveProperty("confidence", "name");
  });
});

describe("symbol", () => {
  it("locates a definition present on the branch", async () => {
    const hits = await store.symbol("auth", "feature");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: "auth", kind: "function", path: "auth.ts" });
  });

  it("returns nothing for an unknown name", async () => {
    expect(await store.symbol("nope", "main")).toEqual([]);
  });
});

describe("transactional writes", () => {
  it("rolls back a failed insertBlob and stays consistent", async () => {
    await store.insertBlob("dupblob", "ts", { defs: [def("only")], refs: [] });
    // Re-inserting the same blob sha violates the PK -> the transaction rolls back.
    await expect(
      store.insertBlob("dupblob", "ts", { defs: [def("ghost")], refs: [] })
    ).rejects.toThrow();
    await store.replaceManifest("b", ".", [{ path: "x.ts", blobSha: "dupblob" }]);
    // The first blob's symbol survives; the rolled-back insert left nothing behind.
    expect((await store.symbol("only", "b")).map((h) => h.name)).toEqual(["only"]);
    expect(await store.symbol("ghost", "b")).toEqual([]);
  });
});

describe("status", () => {
  it("reports branch files plus the shared pool totals", async () => {
    const s = await store.status("main");
    expect(s.branch).toBe("main");
    expect(s.files).toBe(4);
    expect(s.blobs).toBe(5);
    expect(s.symbols).toBe(5);
    expect(s.edges).toBe(4);
    expect(s.roots).toEqual(["."]);
  });
});
