import { describe, expect, it } from "vitest";

import { parseRateLimit } from "../src/headers.js";

const NOW = 1_700_000_000_000;

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("parseRateLimit", () => {
  it("parses the Envoy draft-03 triple including the `3, 3;w=60` limit form", () => {
    const snap = parseRateLimit(
      headers({
        "x-ratelimit-limit": "3, 3;w=60",
        "x-ratelimit-remaining": "2",
        "x-ratelimit-reset": "48"
      }),
      "x-ratelimit",
      NOW
    );
    expect(snap.limit).toBe(3);
    expect(snap.remaining).toBe(2);
    expect(snap.resetSeconds).toBe(48);
    expect(snap.resetAtMs).toBe(NOW + 48_000);
  });

  it("parses a plain integer limit", () => {
    const snap = parseRateLimit(headers({ "x-ratelimit-limit": "5" }), "x-ratelimit", NOW);
    expect(snap.limit).toBe(5);
  });

  it("treats remaining `0` as a real value, not missing", () => {
    const snap = parseRateLimit(headers({ "x-ratelimit-remaining": "0" }), "x-ratelimit", NOW);
    expect(snap.remaining).toBe(0);
  });

  it("leaves fields undefined when headers are absent or non-numeric", () => {
    const snap = parseRateLimit(
      headers({ "x-ratelimit-limit": "abc", "x-ratelimit-remaining": "" }),
      "x-ratelimit",
      NOW
    );
    expect(snap.limit).toBeUndefined();
    expect(snap.remaining).toBeUndefined();
    expect(snap.resetSeconds).toBeUndefined();
    expect(snap.resetAtMs).toBeUndefined();
  });

  it("uses Retry-After in seconds as a fallback", () => {
    const snap = parseRateLimit(headers({ "retry-after": "30" }), "x-ratelimit", NOW);
    expect(snap.retryAfterMs).toBe(30_000);
  });

  it("parses an HTTP-date Retry-After relative to now", () => {
    const future = new Date(NOW + 12_000).toUTCString();
    const snap = parseRateLimit(headers({ "retry-after": future }), "x-ratelimit", NOW);
    // toUTCString drops sub-second precision, so allow a 1s tolerance.
    expect(snap.retryAfterMs).toBeGreaterThanOrEqual(11_000);
    expect(snap.retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it("clamps a past HTTP-date Retry-After to 0", () => {
    const past = new Date(NOW - 5_000).toUTCString();
    const snap = parseRateLimit(headers({ "retry-after": past }), "x-ratelimit", NOW);
    expect(snap.retryAfterMs).toBe(0);
  });

  it("honors a custom header prefix", () => {
    const snap = parseRateLimit(
      headers({ "ratelimit-remaining": "7", "ratelimit-reset": "10" }),
      "ratelimit",
      NOW
    );
    expect(snap.remaining).toBe(7);
    expect(snap.resetAtMs).toBe(NOW + 10_000);
  });
});
