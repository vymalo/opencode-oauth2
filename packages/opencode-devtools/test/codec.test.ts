import { describe, expect, it } from "vitest";

import { run } from "./helpers.js";

describe("codec group", () => {
  it("base64 round-trips", async () => {
    const enc = await run("codec_base64", { mode: "encode", input: "hello" });
    expect(enc.text).toBe("aGVsbG8=");
    const dec = await run("codec_base64", { mode: "decode", input: "aGVsbG8=" });
    expect(dec.text).toBe("hello");
  });

  it("base64url uses the url-safe alphabet", async () => {
    const enc = await run("codec_base64", { mode: "encode", input: "<<???>>", urlSafe: true });
    expect(enc.text).not.toContain("+");
    expect(enc.text).not.toContain("/");
  });

  it("hex round-trips", async () => {
    const enc = await run("codec_hex", { mode: "encode", input: "hi" });
    expect(enc.text).toBe("6869");
    const dec = await run("codec_hex", { mode: "decode", input: "68 69" });
    expect(dec.text).toBe("hi");
  });

  it("url-encodes components and whole urls", async () => {
    const comp = await run("codec_url", { mode: "encode", input: "a b&c" });
    expect(comp.text).toBe("a%20b%26c");
    const whole = await run("codec_url", {
      mode: "encode",
      input: "http://x/a b",
      component: false
    });
    expect(whole.text).toBe("http://x/a%20b");
    const dec = await run("codec_url", { mode: "decode", input: "a%20b%26c" });
    expect(dec.text).toBe("a b&c");
  });

  it("decodes a JWT without verifying", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "123", admin: true })).toString("base64url");
    const token = `${header}.${payload}.sig`;
    const r = await run("codec_jwt_decode", { token });
    const data = (r as { data: Record<string, unknown> }).data;
    expect((data.payload as Record<string, unknown>).sub).toBe("123");
    expect(data.verified).toBe(false);
    expect(data.signaturePresent).toBe(true);
    expect(r.text).toContain("UNVERIFIED");
  });

  it("rejects a malformed JWT", async () => {
    await expect(run("codec_jwt_decode", { token: "nope" })).rejects.toThrow(/not a JWT/);
  });

  it("gzip round-trips through base64", async () => {
    const big = "compress me ".repeat(20);
    const comp = await run("codec_gzip", { mode: "compress", input: big });
    const b64 = (comp as { data: { base64: string } }).data.base64;
    const back = await run("codec_gzip", { mode: "decompress", input: b64 });
    expect(back.text).toBe(big);
  });

  it("deflate round-trips", async () => {
    const comp = await run("codec_gzip", {
      mode: "compress",
      input: "x".repeat(50),
      algorithm: "deflate"
    });
    const b64 = (comp as { data: { base64: string } }).data.base64;
    const back = await run("codec_gzip", { mode: "decompress", input: b64, algorithm: "deflate" });
    expect(back.text).toBe("x".repeat(50));
  });
});
