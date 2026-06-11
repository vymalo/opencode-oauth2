import type { RateLimitOptions } from "./types.js";

export const DEFAULT_MAX_WAIT_MS = 0; // 0 = unlimited (wait the full reset window)
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_HEADER_PREFIX = "x-ratelimit";

const META_KEY = "meta";
const RATE_LIMIT_KEY = "rateLimit";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/** Like {@link asPositiveInt} but accepts `0` — used for `maxWaitMs` where 0 means unlimited. */
function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

/**
 * Parse a provider's `options.meta.rateLimit` block into resolved
 * {@link RateLimitOptions}. Returns `null` when the provider has NOT opted in
 * (no `meta.rateLimit`) or has explicitly disabled it (`enabled: false`) — in
 * both cases the provider's fetch is left untouched.
 *
 * Mirrors `@vymalo/opencode-models-info`'s `parseMetaOptions` opt-in idiom.
 */
export function parseRateLimitOptions(
  providerOptions: Record<string, unknown> | undefined
): RateLimitOptions | null {
  if (!providerOptions) {
    return null;
  }

  const meta = asRecord(providerOptions[META_KEY]);
  if (!meta) {
    return null;
  }

  const rateLimit = asRecord(meta[RATE_LIMIT_KEY]);
  if (!rateLimit) {
    return null;
  }

  const enabled = asBoolean(rateLimit.enabled, true);
  if (!enabled) {
    return null;
  }

  return {
    enabled: true,
    maxWaitMs: asNonNegativeInt(rateLimit.maxWaitMs, DEFAULT_MAX_WAIT_MS),
    maxRetries: asPositiveInt(rateLimit.maxRetries, DEFAULT_MAX_RETRIES),
    headerPrefix: (asString(rateLimit.headerPrefix) ?? DEFAULT_HEADER_PREFIX).toLowerCase()
  };
}
