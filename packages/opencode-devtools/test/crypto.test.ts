import { describe, expect, it } from "vitest";

import { ctx, run } from "./helpers.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("crypto group", () => {
  it("hashes with known vectors", async () => {
    const sha = await run("crypto_hash", { algorithm: "sha256", input: "hello" });
    expect(sha.text).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const md5 = await run("crypto_hash", { algorithm: "md5", input: "hello" });
    expect(md5.text).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("honours input/output encodings", async () => {
    const r = await run("crypto_hash", {
      algorithm: "sha1",
      input: "68656c6c6f",
      inputEncoding: "hex",
      outputEncoding: "base64"
    });
    expect(r.text).toBe("qvTGHdzF6KLavt4PO0gs2a6pQ00=");
  });

  it("computes a stable HMAC", async () => {
    const a = await run("crypto_hmac", { algorithm: "sha256", key: "key", input: "hi" });
    const b = await run("crypto_hmac", { algorithm: "sha256", key: "key", input: "hi" });
    expect(a.text).toBe(b.text);
    expect(a.text).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates v4 and v7 UUIDs", async () => {
    const v4 = await run("crypto_uuid", {});
    expect(v4.text).toMatch(UUID_V4);
    const v7 = await run("crypto_uuid", { version: "7" });
    expect(v7.text).toMatch(UUID_V7);
  });

  it("generates multiple UUIDs as a list", async () => {
    const r = await run("crypto_uuid", { count: 3 });
    const ids = (r as { data: { ids: string[] } }).data.ids;
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4);
    }
  });

  it("caps the requested id count (DoS guard)", async () => {
    const r = await run("crypto_uuid", { count: 50000 });
    expect((r as { data: { ids: string[] } }).data.ids).toHaveLength(1000);
    const u = await run("crypto_ulid", { count: 999999 });
    expect((u as { data: { ids: string[] } }).data.ids).toHaveLength(1000);
  });

  it("generates ULIDs", async () => {
    const r = await run("crypto_ulid", {});
    expect(r.text).toMatch(ULID);
    expect(r.text).toHaveLength(26);
  });

  it("generates multiple ULIDs as a list", async () => {
    const r = await run("crypto_ulid", { count: 2 });
    const ids = (r as { data: { ids: string[] } }).data.ids;
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(ULID);
    }
  });

  it("v7 uuid is time-ordered for increasing clocks", async () => {
    const early = await run(
      "crypto_uuid",
      { version: "7" },
      ctx({ now: () => new Date("2020-01-01") })
    );
    const late = await run(
      "crypto_uuid",
      { version: "7" },
      ctx({ now: () => new Date("2030-01-01") })
    );
    expect(early.text < late.text).toBe(true);
  });

  it("generates random bytes in the requested encoding", async () => {
    const hex = await run("crypto_random", { bytes: 8 });
    expect(hex.text).toBe("0707070707070707");
    const b64 = await run("crypto_random", { bytes: 4, encoding: "base64" });
    expect(b64.text).toBe(Buffer.alloc(4, 7).toString("base64"));
  });

  it("rejects out-of-range byte counts", async () => {
    await expect(run("crypto_random", { bytes: 0 })).rejects.toThrow(/1–4096/);
    await expect(run("crypto_random", { bytes: 99999 })).rejects.toThrow(/1–4096/);
  });

  it("generates ed25519, rsa and ec keypairs", async () => {
    const ed = await run("crypto_keypair", {});
    expect(ed.text).toContain("BEGIN PUBLIC KEY");
    expect(ed.text).toContain("BEGIN PRIVATE KEY");
    const ec = await run("crypto_keypair", { type: "ec" });
    expect((ec as { data: { type: string } }).data.type).toBe("ec");
    const rsa = await run("crypto_keypair", { type: "rsa", modulusLength: 1024 });
    expect((rsa as { data: { privateKey: string } }).data.privateKey).toContain("PRIVATE KEY");
  });

  it("rejects out-of-range RSA modulus (DoS guard)", async () => {
    await expect(run("crypto_keypair", { type: "rsa", modulusLength: 512 })).rejects.toThrow(
      /1024 and 4096/
    );
    await expect(run("crypto_keypair", { type: "rsa", modulusLength: 16384 })).rejects.toThrow(
      /1024 and 4096/
    );
  });
});
