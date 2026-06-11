export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Resolved, defaults-applied rate-limit configuration for a single provider,
 * derived from `provider.options.meta.rateLimit`. See {@link parseRateLimitOptions}.
 */
export interface RateLimitOptions {
  /** Whether rate-limit handling is active for this provider. */
  enabled: boolean;
  /**
   * Upper bound on any single wait (pre-request throttle or 429 backoff), in
   * milliseconds. `0` means unlimited — wait the full reset window.
   */
  maxWaitMs: number;
  /** How many times a 429 is retried before the response is handed back as-is. */
  maxRetries: number;
  /**
   * Lowercased header-name prefix for the IETF draft-03 triple, e.g.
   * `x-ratelimit` → `x-ratelimit-limit` / `-remaining` / `-reset`.
   */
  headerPrefix: string;
}

/**
 * What a single response told us about the current rate-limit window. Every
 * field is optional: a gateway may emit a partial set, and missing/garbage
 * headers leave the field `undefined` (treated as "unknown → let requests flow").
 */
export interface RateLimitSnapshot {
  /** Effective limit — the first integer token of `x-ratelimit-limit`. */
  limit?: number;
  /** Requests left in the current window (`x-ratelimit-remaining`). */
  remaining?: number;
  /** Seconds until the window resets (`x-ratelimit-reset`). */
  resetSeconds?: number;
  /** Absolute reset time in epoch ms, derived from `resetSeconds` + observation time. */
  resetAtMs?: number;
  /** Fallback wait derived from a `Retry-After` header, in ms (seconds or HTTP-date). */
  retryAfterMs?: number;
}
