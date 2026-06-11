import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEADER_PREFIX,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_WAIT_MS,
  parseRateLimitOptions
} from "../src/config.js";

describe("parseRateLimitOptions", () => {
  it("returns null when options are absent", () => {
    expect(parseRateLimitOptions(undefined)).toBeNull();
  });

  it("returns null when there is no meta block", () => {
    expect(parseRateLimitOptions({ baseURL: "https://x.test" })).toBeNull();
  });

  it("returns null when meta has no rateLimit block", () => {
    expect(parseRateLimitOptions({ meta: { modelsInfoUrl: "/models" } })).toBeNull();
  });

  it("returns null when rateLimit is explicitly disabled", () => {
    expect(parseRateLimitOptions({ meta: { rateLimit: { enabled: false } } })).toBeNull();
  });

  it("applies defaults for an empty rateLimit block", () => {
    const opts = parseRateLimitOptions({ meta: { rateLimit: {} } });
    expect(opts).toEqual({
      enabled: true,
      maxWaitMs: DEFAULT_MAX_WAIT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      headerPrefix: DEFAULT_HEADER_PREFIX
    });
  });

  it("accepts maxWaitMs of 0 as unlimited", () => {
    const opts = parseRateLimitOptions({ meta: { rateLimit: { maxWaitMs: 0 } } });
    expect(opts?.maxWaitMs).toBe(0);
  });

  it("reads explicit values and lowercases the header prefix", () => {
    const opts = parseRateLimitOptions({
      meta: { rateLimit: { maxWaitMs: 5000, maxRetries: 2, headerPrefix: "X-RateLimit" } }
    });
    expect(opts).toEqual({
      enabled: true,
      maxWaitMs: 5000,
      maxRetries: 2,
      headerPrefix: "x-ratelimit"
    });
  });

  it("falls back to defaults for garbage values", () => {
    const opts = parseRateLimitOptions({
      meta: { rateLimit: { maxWaitMs: -1, maxRetries: 0, headerPrefix: "  " } }
    });
    expect(opts?.maxWaitMs).toBe(DEFAULT_MAX_WAIT_MS);
    expect(opts?.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(opts?.headerPrefix).toBe(DEFAULT_HEADER_PREFIX);
  });
});
