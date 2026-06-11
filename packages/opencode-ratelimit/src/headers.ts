import type { RateLimitSnapshot } from "./types.js";

/**
 * Parse the IETF draft-03 rate-limit triple (as emitted by Envoy Gateway's
 * global rate limit) plus an optional `Retry-After` fallback into a
 * {@link RateLimitSnapshot}.
 *
 * Envoy emits these on BOTH 200 and 429 responses, e.g.:
 *   x-ratelimit-limit:     3, 3;w=60
 *   x-ratelimit-remaining: 2
 *   x-ratelimit-reset:     48          (seconds until the bucket resets)
 *
 * `Retry-After` is NOT emitted by Envoy Gateway today, so it is only consulted
 * as a fallback when present (all-digits → seconds; otherwise an HTTP-date).
 *
 * Header names are case-insensitive (the Fetch `Headers` object lowercases
 * them); `prefix` should already be lowercased by the caller.
 */
export function parseRateLimit(headers: Headers, prefix: string, nowMs: number): RateLimitSnapshot {
  const snapshot: RateLimitSnapshot = {};

  const limit = parseLimit(headers.get(`${prefix}-limit`));
  if (limit !== undefined) {
    snapshot.limit = limit;
  }

  const remaining = parseInteger(headers.get(`${prefix}-remaining`));
  if (remaining !== undefined) {
    snapshot.remaining = remaining;
  }

  const resetSeconds = parseInteger(headers.get(`${prefix}-reset`));
  if (resetSeconds !== undefined) {
    snapshot.resetSeconds = resetSeconds;
    snapshot.resetAtMs = nowMs + resetSeconds * 1000;
  }

  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), nowMs);
  if (retryAfterMs !== undefined) {
    snapshot.retryAfterMs = retryAfterMs;
  }

  return snapshot;
}

/**
 * `x-ratelimit-limit` carries the effective limit followed by optional
 * window descriptors, e.g. `"3, 3;w=60"`. We take the first comma-separated
 * token and strip any `;w=...` quota-policy suffix → `3`. A plain `"3"` works too.
 */
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const firstToken = raw.split(",", 1)[0]?.split(";", 1)[0];
  return parseInteger(firstToken);
}

function parseInteger(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `Retry-After` is either a non-negative integer (delay-seconds) or an
 * HTTP-date. Returns the wait in ms, never negative.
 */
function parseRetryAfter(raw: string | null, nowMs: number): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - nowMs);
}
