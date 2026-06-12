export type LogLevel = "debug" | "info" | "warn" | "error";

/** How rate-limit state is partitioned. */
export type RateLimitScope = "provider" | "model";

/** What to do when a tier matches the observed reset window. */
export type RateLimitAction = "wait" | "error";

/**
 * One band of the tiered policy, matched by the magnitude of the observed
 * `x-ratelimit-reset`. Tiers let a config distinguish a short burst reset
 * (worth waiting through) from a multi-day budget reset (should error fast) —
 * both arrive as the same header, so reset duration is the only discriminator.
 */
export interface RateLimitTier {
  /**
   * Inclusive upper bound, in seconds, of the resets this tier matches.
   * `null` is the catch-all (matches any reset; sorts last).
   */
  maxResetSeconds: number | null;
  /** `"wait"` throttles/backs-off; `"error"` surfaces the 429 immediately. */
  action: RateLimitAction;
  /** For `"wait"`: cap on a single wait, ms. `0` = unlimited. Ignored for `"error"`. */
  maxWaitMs: number;
  /** For `"wait"`: 429 retries before the response is surfaced. Ignored for `"error"`. */
  maxRetries: number;
}

/**
 * Resolved, defaults-applied rate-limit configuration for a single provider,
 * derived from `provider.options.meta.rateLimit`. See `parseRateLimitOptions`.
 */
export interface RateLimitOptions {
  /** Whether rate-limit handling is active for this provider. */
  enabled: boolean;
  /**
   * `"model"` keys cooldown state per `(provider, model)` so exhausting one
   * model's bucket doesn't gate the others — matches gateways that rate-limit
   * per model. `"provider"` shares one cooldown across the whole provider.
   */
  scope: RateLimitScope;
  /**
   * Lowercased header-name prefix for the IETF draft-03 triple, e.g.
   * `x-ratelimit` → `x-ratelimit-limit` / `-remaining` / `-reset`.
   */
  headerPrefix: string;
  /**
   * Ordered policy bands, sorted ascending by `maxResetSeconds` (catch-all
   * last). Always non-empty and always ends with a catch-all tier. A flat
   * `maxWaitMs`/`maxRetries` config is normalized into a single catch-all
   * `"wait"` tier.
   */
  tiers: RateLimitTier[];
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
