import { parseRateLimitOptions, selectTier } from "./config.js";
import { parseRateLimit } from "./headers.js";
import type { Logger } from "./logging.js";
import type { RateLimitOptions, RateLimitSnapshot } from "./types.js";

/** Fallback backoff when a 429 carries no `x-ratelimit-reset` and no `Retry-After`. */
export const DEFAULT_BACKOFF_MS = 1000;

/**
 * Mutable, in-memory rate-limit state for a single bucket (a provider, or a
 * `(provider, model)` pair when `scope: "model"`). Lives for the process
 * lifetime in the provider's state store. Never persisted — a reset window is
 * measured in seconds, so survival across process boots is pointless.
 */
export interface ProviderRateState {
  /**
   * Epoch ms until which new requests should be held back. 0 = no cooldown.
   * The sole gate driver — set from a response's `x-ratelimit-reset` (when
   * `remaining` hits 0, and the matched tier is `"wait"`) or from a 429 backoff.
   */
  cooldownUntilMs: number;
  /** The `maxWaitMs` of the tier that armed the current cooldown (0 = unlimited). */
  cooldownMaxWaitMs: number;
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
  return { cooldownUntilMs: 0, cooldownMaxWaitMs: 0 };
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

/** A per-bucket state store (key = provider id, or `${providerId}\0${model}`). */
export type RateStateStore = Map<string, ProviderRateState>;

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
    const store: RateStateStore = new Map();
    options.fetch = makeRateLimitFetch(providerId, opts, store, deps, delegate);
    enabledCount += 1;
    deps.logger.info("ratelimit_provider_enabled", {
      providerId,
      scope: opts.scope,
      tiers: opts.tiers.length,
      headerPrefix: opts.headerPrefix
    });
  }

  deps.logger.info("ratelimit_plugin_initialized", { providerCount: enabledCount });
}

/**
 * Build the fetch wrapper for one provider. The wrapper:
 *  1. Resolves the bucket (provider, or `(provider, model)` under `scope: "model"`).
 *  2. Pre-request gate: if that bucket's cooldown is armed, waits until it clears.
 *  3. Sends the request via the underlying fetch.
 *  4. Reads the rate-limit headers; selects the policy tier by reset magnitude.
 *     On `remaining: 0` it arms the gate for the next callers (only when the
 *     matched tier is `"wait"`).
 *  5. On a 429: a `"wait"` tier waits the reset window and retries (up to the
 *     tier's `maxRetries`); an `"error"` tier surfaces the 429 immediately.
 *
 * The Response is returned untouched (no `.clone()`) — we only read `status`
 * and `headers`, so the body stream is delivered to OpenCode intact.
 */
export function makeRateLimitFetch(
  providerId: string,
  opts: RateLimitOptions,
  store: RateStateStore,
  deps: RateLimitDeps,
  delegate?: typeof fetch
): typeof fetch {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const underlying = delegate ?? deps.fetchImpl ?? globalThis.fetch;
  const { logger } = deps;

  const isRequest = (value: RequestInfo | URL): value is Request =>
    typeof Request !== "undefined" && value instanceof Request;

  const wrapped: typeof fetch = async (input, init) => {
    // Honor an abort signal whether it rides on `init` or on a `Request` input.
    const signal = init?.signal ?? (isRequest(input) ? input.signal : undefined) ?? undefined;
    const model = opts.scope === "model" ? await modelFromRequest(input, init) : undefined;
    const key = model ? `${providerId}\u0000${model}` : providerId;
    let state = store.get(key);
    if (!state) {
      state = createProviderState();
      store.set(key, state);
    }

    // 2. Pre-request gate — wait out a cooldown a previous "wait" tier armed.
    if (state.cooldownUntilMs > now()) {
      const waitMs = clampWait(state.cooldownUntilMs - now(), state.cooldownMaxWaitMs);
      if (waitMs > 0) {
        logger.info("ratelimit_throttle_wait", { providerId, model, waitMs });
        await waitGate(
          state,
          sleep,
          now,
          state.cooldownMaxWaitMs,
          signal,
          logger,
          providerId,
          model,
          "pre_request"
        );
      }
    }

    // 3-5. Attempt loop.
    let attempt = 0;
    for (;;) {
      // A Request body is single-use; send a fresh clone each attempt so a
      // wait-tier retry doesn't fail with "body already used". (The original is
      // never sent directly, so each clone has an unconsumed body.)
      const attemptInput = isRequest(input) ? input.clone() : input;
      const response = await underlying(attemptInput, init);
      const snapshot = readSnapshot(response, opts, now(), logger, providerId);
      logger.debug("ratelimit_quota", {
        providerId,
        model,
        remaining: snapshot.remaining,
        limit: snapshot.limit,
        resetSeconds: snapshot.resetSeconds
      });

      if (response.status !== 429) {
        // Arm the gate for the NEXT callers when the window is exhausted — but
        // only under a "wait" tier. An "error" tier wants the next request to
        // hit a real 429 and be surfaced, so we leave the gate unarmed.
        if (
          snapshot.remaining !== undefined &&
          snapshot.remaining <= 0 &&
          snapshot.resetAtMs !== undefined
        ) {
          const tier = selectTier(opts.tiers, effectiveResetSeconds(snapshot));
          if (tier.action === "wait") {
            state.cooldownUntilMs = snapshot.resetAtMs;
            state.cooldownMaxWaitMs = tier.maxWaitMs;
          } else {
            // Error tier → don't arm, and drop any stale cooldown a prior
            // "wait" window left so the next request hits a real 429 at once.
            state.cooldownUntilMs = 0;
            state.cooldownMaxWaitMs = 0;
          }
        }
        return response;
      }

      const tier = selectTier(opts.tiers, effectiveResetSeconds(snapshot));
      if (tier.action === "error") {
        // Drop any cooldown a prior "wait" tier armed, so the fail-fast is
        // actually fast — later requests must not sleep a stale window first.
        state.cooldownUntilMs = 0;
        state.cooldownMaxWaitMs = 0;
        logger.warn("ratelimit_failfast", {
          providerId,
          model,
          resetSeconds: snapshot.resetSeconds
        });
        return response;
      }

      if (attempt >= tier.maxRetries) {
        logger.error("ratelimit_giveup", { providerId, model, attempts: attempt });
        return response;
      }

      const waitMs = clampWait(computeBackoff(snapshot, now()), tier.maxWaitMs);
      state.cooldownUntilMs = now() + waitMs;
      state.cooldownMaxWaitMs = tier.maxWaitMs;
      logger.warn("ratelimit_429_backoff", {
        providerId,
        model,
        attempt: attempt + 1,
        waitMs,
        resetSeconds: snapshot.resetSeconds
      });
      await waitGate(
        state,
        sleep,
        now,
        tier.maxWaitMs,
        signal,
        logger,
        providerId,
        model,
        "backoff"
      );
      attempt += 1;
    }
  };

  return wrapped;
}

/**
 * Best-effort extraction of the `model` from an OpenAI-compatible request.
 * The AI SDK calls `fetch(url, { body: "<json>" })`, so the common path reads a
 * JSON string body synchronously (non-destructive). It also supports the
 * `fetch(new Request(...))` shape by reading a clone of the Request body, so a
 * Request-style caller doesn't silently collapse to the provider-wide bucket.
 * Anything unparseable → `undefined` → caller falls back to the provider bucket.
 */
async function modelFromRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<string | undefined> {
  const fromInit = modelFromBody(init?.body);
  if (fromInit !== undefined) {
    return fromInit;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      return modelFromBody(await input.clone().text());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function modelFromBody(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reset magnitude (seconds) used for tier selection: prefer `x-ratelimit-reset`,
 * else derive from a `Retry-After` fallback — so a `Retry-After`-only 429 with a
 * multi-day delay still lands in a long-reset (`error`) tier instead of the
 * smallest band.
 */
function effectiveResetSeconds(snapshot: RateLimitSnapshot): number | undefined {
  if (snapshot.resetSeconds !== undefined) {
    return snapshot.resetSeconds;
  }
  if (snapshot.retryAfterMs !== undefined) {
    return Math.ceil(snapshot.retryAfterMs / 1000);
  }
  return undefined;
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
 *    with a further-out reset) while we were waiting we wait again for the
 *    remainder instead of returning early and hammering the gateway.
 *
 * `maxWaitMs` (when > 0) bounds the TOTAL wait of a single call: once a caller
 * has waited that long it proceeds even if the window hasn't fully elapsed. A
 * caller that needs LESS than the in-flight shared timer (the window shrank, or
 * the timer was created by a caller with a later deadline) falls back to its own
 * private sleep so it is never held past its own required time.
 */
async function waitGate(
  state: ProviderRateState,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  now: () => number,
  maxWaitMs: number,
  signal: AbortSignal | undefined,
  logger: Logger,
  providerId: string,
  model: string | undefined,
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
        logger.warn("ratelimit_wait_aborted", { providerId, model, phase });
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
