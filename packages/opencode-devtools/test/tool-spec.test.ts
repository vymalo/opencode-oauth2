import { describe, expect, it } from "vitest";

import { json, optBool, optString, reqNumber, reqString, text } from "../src/tool-spec.js";

describe("result builders", () => {
  it("build text and json results", () => {
    expect(text("hi")).toEqual({ kind: "text", text: "hi" });
    expect(json({ a: 1 }, "summary")).toEqual({ kind: "json", data: { a: 1 }, text: "summary" });
  });
});

describe("arg coercion", () => {
  it("reqString / reqNumber accept and reject", () => {
    expect(reqString({ k: "v" }, "k")).toBe("v");
    expect(() => reqString({ k: 1 }, "k")).toThrow(/must be a string/);
    expect(reqNumber({ k: 2 }, "k")).toBe(2);
    expect(() => reqNumber({ k: "x" }, "k")).toThrow(/must be a number/);
    expect(() => reqNumber({ k: Number.NaN }, "k")).toThrow(/must be a number/);
  });

  it("optString / optBool return undefined for wrong types", () => {
    expect(optString({ k: "v" }, "k")).toBe("v");
    expect(optString({ k: 1 }, "k")).toBeUndefined();
    expect(optBool({ k: true }, "k")).toBe(true);
    expect(optBool({ k: "x" }, "k")).toBeUndefined();
  });
});
