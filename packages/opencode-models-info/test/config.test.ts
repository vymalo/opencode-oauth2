import { describe, expect, it } from "vitest";

import { DEFAULT_TIMEOUT_MS, DEFAULT_TTL_SECONDS, parseMetaOptions } from "../src/config.js";

describe("parseMetaOptions", () => {
  it("returns null when no provider options exist", () => {
    expect(parseMetaOptions(undefined)).toBeNull();
  });

  it("returns null when meta is absent or not an object", () => {
    expect(parseMetaOptions({})).toBeNull();
    expect(parseMetaOptions({ meta: "no" })).toBeNull();
    expect(parseMetaOptions({ meta: [] })).toBeNull();
  });

  it("returns null when modelsInfoUrl is missing or empty", () => {
    expect(parseMetaOptions({ meta: {} })).toBeNull();
    expect(parseMetaOptions({ meta: { modelsInfoUrl: "" } })).toBeNull();
    expect(parseMetaOptions({ meta: { modelsInfoUrl: "   " } })).toBeNull();
    expect(parseMetaOptions({ meta: { modelsInfoUrl: 42 } })).toBeNull();
  });

  it("applies defaults for optional fields", () => {
    const out = parseMetaOptions({ meta: { modelsInfoUrl: "https://x.test/m" } });
    expect(out).toEqual({
      modelsInfoUrl: "https://x.test/m",
      modelsInfoTtlSeconds: DEFAULT_TTL_SECONDS,
      modelsInfoTimeoutMs: DEFAULT_TIMEOUT_MS,
      modelsInfoHeaders: undefined,
      modelsInfoFormat: "openrouter"
    });
  });

  it("coerces positive integers and ignores invalid numeric inputs", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoTtlSeconds: 60.7,
        modelsInfoTimeoutMs: -1
      }
    });
    expect(out?.modelsInfoTtlSeconds).toBe(60);
    expect(out?.modelsInfoTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("filters non-string header values out of modelsInfoHeaders", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoHeaders: { "x-tenant": "t1", bogus: 123, empty: "" }
      }
    });
    expect(out?.modelsInfoHeaders).toEqual({ "x-tenant": "t1" });
  });

  it("returns undefined headers when the map is empty after filtering", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoHeaders: { bogus: 123 }
      }
    });
    expect(out?.modelsInfoHeaders).toBeUndefined();
  });

  it("resolves relative URLs against baseURL with or without trailing slash", () => {
    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "/models" }
      })?.modelsInfoUrl
    ).toBe("https://x.test/v1/models");

    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1/",
        meta: { modelsInfoUrl: "models" }
      })?.modelsInfoUrl
    ).toBe("https://x.test/v1/models");
  });

  it("leaves absolute URLs untouched even when baseURL is present", () => {
    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "https://other.test/models" }
      })?.modelsInfoUrl
    ).toBe("https://other.test/models");
  });

  it("keeps the relative path verbatim when baseURL is absent", () => {
    expect(
      parseMetaOptions({
        meta: { modelsInfoUrl: "/models" }
      })?.modelsInfoUrl
    ).toBe("/models");
  });
});
