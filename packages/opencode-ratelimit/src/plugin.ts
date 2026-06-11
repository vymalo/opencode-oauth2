import { parseRateLimitOptions } from "./config.js";
import { parseRateLimit } from "./headers.js";
import type { Logger } from "./logging.js";
import type { RateLimitOptions, RateLimitSnapshot } from "./types.js";

/** Fallback backoff when a 429 carries no `x-ratelimit-reset` and no `Retry-After`. */
export const DEFAULT_BACKOFF_MS = 1000;

/**
 * Mutable, in-memory rate-limit state for a single provider. Created fresh per
 * {@link installRateLimiter} call and captured by the provider's fetch wrapper
 * closure, so it lives for the process lifetime. Never persisted — a reset
 * window is measured in seconds, so survival across process boots is pointless.
 */
export interface ProviderRateState {
  /**
   * Epoch ms until which new requests should be held back. 0 = no cooldown.
   * This is the ONLY field that drives the gate — it is set from a response's
   * `x-ratelimit-reset` (when `remaining` hits 0) or from a 429 backoff. We
   * deliberately do not retain the raw `remaining`/`limit`: out-of-order
   * responses would race on it and nothing reads it (the `ratelimit_quota` log
   * uses the per-response snapshot directly).
   */
  cooldownUntilMs: number;
  /** A single in-flight wait shared by every caller during a cooldown window. */
  cooldownPromise?: Promise<void>;
  /**
   * Epoch ms at which {@link cooldownPromise} is scheduled to resolve. Lets a
   * caller that needs a shorter wait detect a too-long shared timer and fall
   * back to its own sleep, so it never waits past its required time / `maxWaitMs`.
   */
  cooldownPromiseUntilMs?: number;
}

export function createProviderState(): ProviderRateState {
  return { cooldownUntilMs: 0 };
}

export interface RateLimitDeps {
  logger: Logger;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a real `setTimeout`-based, abort-aware sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Underlying fetch when a provider has no pre-existing `options.fetch`. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ProviderConfigLike {
  options?: Record<string, unknown>;
}

export interface InstallConfigInput {
  provider?: Record<string, ProviderConfigLike | undefined>;
}

/**
 * Walk every provider in the assembled OpenCode config; for each one that has
 * opted in via `options.meta.rateLimit`, wrap its `options.fetch` with a
 * rate-limit-aware fetch. Synchronous — all real work happens lazily inside the
 * wrapper at request time.
 */
export function installRateLimiter(input: InstallConfigInput, deps: RateLimitDeps): void {
  const providers = input.provider;
  if (!providers) {
    deps.logger.info("ratelimit_plugin_initialized", { providerCount: 0 });
    return;
  }

  let enabledCount = 0;
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig) {
      continue;
    }
    const opts = parseRateLimitOptions(providerConfig.options);
    if (!opts) {
      deps.logger.debug("ratelimit_provider_skipped", { providerId, reason: "not_opted_in" });
      continue;
    }

    const options = (providerConfig.options ??= {});
    // Compose with any fetch a prior plugin already installed (capture it now,
    // not at call time, so we delegate to the original — not to ourselves).
    const delegate =
      typeof options.fetch === "function" ? (options.fetch as typeof fetch) : undefined;
    const state = createProviderState();
    options.fetch = makeRateLimitFetch(providerId, opts, state, deps, delegate);
    enabledCount += 1;
    deps.logger.info("ratelimit_provider_enabled", {
      providerId,
      maxWaitMs: opts.maxWaitMs,
      maxRetries: opts.maxRetries,
      headerPrefix: opts.headerPrefix
    });
  }

  deps.logger.info("ratelimit_plugin_initialized", { providerCount: enabledCount });
}

/**
 * Build the fetch wrapper for one provider. The wrapper:
 *  1. Pre-request gate: if a cooldown window is armed, waits until it clears.
 *  2. Sends the request via the underlying fetch.
 *  3. Reads the rate-limit headers; if the window is exhausted, arms the gate
 *     (`cooldownUntilMs`) for the next callers.
 *  4. On a 429, waits the reset window and retries (up to `maxRetries`).
 *
 * The Response is returned untouched (no `.clone()`) — we only read `status`
 * and `headers`, so the body stream is delivered to OpenCode intact.
 */
export function makeRateLimitFetch(
  providerId: string,
  opts: RateLimitOptions,
  state: ProviderRateState,
  deps: RateLimitDeps,
  delegate?: typeof fetch
): typeof fetch {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const underlying = delegate ?? deps.fetchImpl ?? globalThis.fetch;
  const { logger } = deps;

  const wrapped: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? undefined;

    // 1. Pre-request gate.
    if (state.cooldownUntilMs > now()) {
      const waitMs = clampWait(state.cooldownUntilMs - now(), opts.maxWaitMs);
      if (waitMs > 0) {
        logger.info("ratelimit_throttle_wait", { providerId, waitMs, reason: "remaining_zero" });
        await waitGate(
          state,
          sleep,
          now,
          opts.maxWaitMs,
          signal,
          logger,
          providerId,
          "pre_request"
        );
      }
    }

    // 2-4. Attempt loop.
    let attempt = 0;
    for (;;) {
      const response = await underlying(input, init);
      const snapshot = readSnapshot(response, opts, now(), logger, providerId);
      logger.debug("ratelimit_quota", {
        providerId,
        remaining: snapshot.remaining,
        limit: snapshot.limit,
        resetSeconds: snapshot.resetSeconds
      });

      if (response.status !== 429) {
        // Arm the gate for the NEXT callers when the window is exhausted.
        if (
          snapshot.remaining !== undefined &&
          snapshot.remaining <= 0 &&
          snapshot.resetAtMs !== undefined
        ) {
          state.cooldownUntilMs = snapshot.resetAtMs;
        }
        return response;
      }

      if (attempt >= opts.maxRetries) {
        logger.error("ratelimit_giveup", { providerId, attempts: attempt });
        return response;
      }

      const waitMs = clampWait(computeBackoff(snapshot, now()), opts.maxWaitMs);
      state.cooldownUntilMs = now() + waitMs;
      logger.warn("ratelimit_429_backoff", {
        providerId,
        attempt: attempt + 1,
        waitMs,
        resetSeconds: snapshot.resetSeconds
      });
      await waitGate(state, sleep, now, opts.maxWaitMs, signal, logger, providerId, "backoff");
      attempt += 1;
    }
  };

  return wrapped;
}

function readSnapshot(
  response: Response,
  opts: RateLimitOptions,
  nowMs: number,
  logger: Logger,
  providerId: string
): RateLimitSnapshot {
  try {
    return parseRateLimit(response.headers, opts.headerPrefix, nowMs);
  } catch (error) {
    logger.debug("ratelimit_header_parse_failed", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

function computeBackoff(snapshot: RateLimitSnapshot, nowMs: number): number {
  if (snapshot.resetAtMs !== undefined) {
    return Math.max(0, snapshot.resetAtMs - nowMs);
  }
  if (snapshot.retryAfterMs !== undefined) {
    return snapshot.retryAfterMs;
  }
  return DEFAULT_BACKOFF_MS;
}

/** `maxWaitMs` of 0 means unlimited (wait the full reset window). */
function clampWait(ms: number, maxWaitMs: number): number {
  const nonNegative = Math.max(0, ms);
  return maxWaitMs > 0 ? Math.min(nonNegative, maxWaitMs) : nonNegative;
}

/**
 * Wait until `state.cooldownUntilMs` has elapsed. Two concurrency properties:
 *
 *  - **One shared timer.** The first caller to hit the gate creates the timer on
 *    `state.cooldownPromise`; concurrent callers await that same timer rather
 *    than each starting their own, so a burst during cooldown produces ONE wait,
 *    not N. The shared timer is not tied to any single caller's `signal` — each
 *    caller races it against its own signal (see `raceWithAbort`), so one
 *    request's cancellation never aborts the others.
 *  - **Honors the longest window.** After the shared timer resolves we re-check
 *    `cooldownUntilMs`. If another caller extended the window (e.g. a 429 landed
 *    with a further-out reset) while we were waiting — or the shared timer was
 *    created for a shorter wait than we now require — we wait again for the
 *    remainder instead of returning early and hammering the gateway.
 *
 * `maxWaitMs` (when > 0) bounds the TOTAL wait of a single call: once a caller
 * has waited that long it proceeds even if the window hasn't fully elapsed. A
 * caller that needs LESS than the in-flight shared timer (the window shrank, or
 * the timer was created by a caller with a later deadline) falls back to its own
 * private sleep so it is never held past its own required time — the shared
 * timer is reserved for the common case where everyone is waiting the same span.
 */
async function waitGate(
  state: ProviderRateState,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  now: () => number,
  maxWaitMs: number,
  signal: AbortSignal | undefined,
  logger: Logger,
  providerId: string,
  phase: "pre_request" | "backoff"
): Promise<void> {
  const deadlineMs = maxWaitMs > 0 ? now() + maxWaitMs : Number.POSITIVE_INFINITY;
  for (;;) {
    const target = Math.min(state.cooldownUntilMs, deadlineMs);
    const remainingMs = target - now();
    if (remainingMs <= 0) {
      return;
    }

    // Reuse the shared timer only if it won't make us wait longer than we need.
    let pending = state.cooldownPromise;
    if (
      pending &&
      state.cooldownPromiseUntilMs !== undefined &&
      state.cooldownPromiseUntilMs - now() > remainingMs
    ) {
      pending = undefined;
    }
    if (!pending) {
      const created = sleep(remainingMs).finally(() => {
        if (state.cooldownPromise === created) {
          state.cooldownPromise = undefined;
          state.cooldownPromiseUntilMs = undefined;
        }
      });
      // Publish as the shared timer only when there isn't already a (shorter)
      // one in flight — never clobber it with our longer/private wait.
      if (!state.cooldownPromise) {
        state.cooldownPromise = created;
        state.cooldownPromiseUntilMs = now() + remainingMs;
      }
      pending = created;
    }

    try {
      await raceWithAbort(pending, signal);
    } catch (error) {
      if (isAbortError(error)) {
        logger.warn("ratelimit_wait_aborted", { providerId, phase });
      }
      throw error;
    }
    // Loop: re-check in case the window was extended while we waited.
  }
}

function raceWithAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
