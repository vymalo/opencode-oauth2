import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logging.js";
import {
  createProviderState,
  type InstallConfigInput,
  installRateLimiter,
  makeRateLimitFetch,
  type RateLimitDeps,
  type RateStateStore
} from "../src/plugin.js";
import type { RateLimitOptions, RateLimitScope, RateLimitTier } from "../src/types.js";

const NOW = 1_700_000_000_000;

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

/** Fake clock whose `sleep` advances time synchronously and resolves immediately. */
function fakeClock(start = NOW) {
  const ref = { t: start };
  return {
    now: () => ref.t,
    advance: (ms: number) => {
      ref.t += ms;
    },
    sleep: vi.fn(async (ms: number) => {
      ref.t += ms;
    })
  };
}

function makeOpts(
  over: {
    maxWaitMs?: number;
    maxRetries?: number;
    scope?: RateLimitScope;
    tiers?: RateLimitTier[];
  } = {}
): RateLimitOptions {
  const { maxWaitMs = 0, maxRetries = 5, scope = "provider", tiers } = over;
  return {
    enabled: true,
    scope,
    headerPrefix: "x-ratelimit",
    tiers: tiers ?? [{ maxResetSeconds: null, action: "wait", maxWaitMs, maxRetries }]
  };
}

function res(status: number, headers: Record<string, string> = {}, body?: string): Response {
  return new Response(body ?? null, { status, headers });
}

interface Harness {
  logger: Logger;
  clock: ReturnType<typeof fakeClock>;
  fetchImpl: ReturnType<typeof vi.fn>;
  store: RateStateStore;
  state: ReturnType<typeof createProviderState>;
  deps: RateLimitDeps;
  fetch: typeof fetch;
}

function harness(opts: RateLimitOptions = makeOpts()): Harness {
  const logger = silentLogger();
  const clock = fakeClock();
  const fetchImpl = vi.fn();
  const store: RateStateStore = new Map();
  const state = createProviderState();
  store.set("test-provider", state); // provider scope → bucket key is the provider id
  const deps: RateLimitDeps = { logger, now: clock.now, sleep: clock.sleep, fetchImpl };
  const fetch = makeRateLimitFetch("test-provider", opts, store, deps);
  return { logger, clock, fetchImpl, store, state, deps, fetch };
}

function eventNames(spy: Logger[keyof Logger]): string[] {
  return (spy as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("makeRateLimitFetch", () => {
  it("logs the parsed quota without waiting on a healthy response", async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(
      res(200, {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "2",
        "x-ratelimit-reset": "30"
      })
    );

    const response = await h.fetch("https://api.test/v1/chat");

    expect(response.status).toBe(200);
    expect(h.clock.sleep).not.toHaveBeenCalled();
    expect(h.state.cooldownUntilMs).toBe(0); // healthy → gate not armed
    expect(h.logger.debug).toHaveBeenCalledWith(
      "ratelimit_quota",
      expect.objectContaining({ remaining: 2, limit: 10, resetSeconds: 30 })
    );
  });

  it("proactively throttles the next request after remaining hits 0", async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }))
      .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "5" }));

    await h.fetch("https://api.test"); // arms the cooldown
    expect(h.clock.sleep).not.toHaveBeenCalled();

    const second = await h.fetch("https://api.test"); // gated

    expect(h.clock.sleep).toHaveBeenCalledTimes(1);
    expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
    expect(second.status).toBe(200);
    expect(eventNames(h.logger.info)).toContain("ratelimit_throttle_wait");
  });

  it("backs off and retries on a 429 then returns the 200", async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(res(429, { "x-ratelimit-reset": "5" }))
      .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "3" }));

    const response = await h.fetch("https://api.test");

    expect(response.status).toBe(200);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.clock.sleep).toHaveBeenCalledTimes(1);
    expect(h.clock.sleep).toHaveBeenCalledWith(5_000);
    expect(eventNames(h.logger.warn)).toContain("ratelimit_429_backoff");
  });

  it("gives up after maxRetries and returns the final 429", async () => {
    const h = harness(makeOpts({ maxRetries: 2 }));
    h.fetchImpl.mockResolvedValue(res(429, { "x-ratelimit-reset": "5" }));

    const response = await h.fetch("https://api.test");

    expect(response.status).toBe(429);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(h.clock.sleep).toHaveBeenCalledTimes(2);
    expect(eventNames(h.logger.error)).toContain("ratelimit_giveup");
  });

  it("falls back to Retry-After when no x-ratelimit-reset is present", async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(res(429, { "retry-after": "5" }))
      .mockResolvedValueOnce(res(200));

    await h.fetch("https://api.test");

    expect(h.clock.sleep).toHaveBeenCalledWith(5_000);
  });

  it("caps a long wait at maxWaitMs", async () => {
    const h = harness(makeOpts({ maxWaitMs: 1_000 }));
    h.fetchImpl
      .mockResolvedValueOnce(res(429, { "x-ratelimit-reset": "60" }))
      .mockResolvedValueOnce(res(200));

    await h.fetch("https://api.test");

    expect(h.clock.sleep).toHaveBeenCalledWith(1_000);
  });

  it("returns the same Response instance (no body clone)", async () => {
    const h = harness();
    const original = res(200, { "x-ratelimit-remaining": "9" }, "hello");
    h.fetchImpl.mockResolvedValueOnce(original);

    const response = await h.fetch("https://api.test");

    expect(response).toBe(original);
    expect(await response.text()).toBe("hello");
  });

  describe("tiers", () => {
    const tiered = () =>
      makeOpts({
        tiers: [
          { maxResetSeconds: 120, action: "wait", maxWaitMs: 0, maxRetries: 3 }, // burst → wait
          { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: 0 } // long → fail fast
        ]
      });

    it("waits + retries on a 429 whose reset falls in a wait tier", async () => {
      const h = harness(tiered());
      h.fetchImpl
        .mockResolvedValueOnce(res(429, { "x-ratelimit-reset": "60" })) // ≤120 → wait tier
        .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "5" }));

      const response = await h.fetch("https://api.test");

      expect(response.status).toBe(200);
      expect(h.clock.sleep).toHaveBeenCalledWith(60_000);
      expect(eventNames(h.logger.warn)).toContain("ratelimit_429_backoff");
    });

    it("fails fast on a 429 whose reset falls in an error tier (no wait, no retry)", async () => {
      const h = harness(tiered());
      h.fetchImpl.mockResolvedValueOnce(res(429, { "x-ratelimit-reset": "2592000" })); // 30d → error tier

      const response = await h.fetch("https://api.test");

      expect(response.status).toBe(429);
      expect(h.fetchImpl).toHaveBeenCalledTimes(1); // surfaced immediately, no retry
      expect(h.clock.sleep).not.toHaveBeenCalled(); // no wait
      expect(eventNames(h.logger.warn)).toContain("ratelimit_failfast");
    });

    it("does not arm the gate on remaining:0 when the reset is in an error tier", async () => {
      const h = harness(tiered());
      h.fetchImpl.mockResolvedValueOnce(
        res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2592000" })
      );

      await h.fetch("https://api.test");

      expect(h.state.cooldownUntilMs).toBe(0); // error tier → next request will hit a real 429
    });

    it("handles a real Envoy header set (multi-policy limit, 429 reset=11)", async () => {
      // Exact headers observed from the live gateway.
      const REAL = {
        "x-envoy-upstream-service-time": "8266",
        "x-ratelimit-limit": "200, 200;w=60, 200000;w=60, 50000000;w=2592000",
        "x-ratelimit-remaining": "199",
        "x-ratelimit-reset": "11"
      };
      const h = harness(tiered());
      h.fetchImpl
        .mockResolvedValueOnce(res(429, REAL)) // reset 11 ≤ 120 → wait tier
        .mockResolvedValueOnce(res(200, { ...REAL, "x-ratelimit-remaining": "198" }));

      const response = await h.fetch("https://api.test");

      expect(response.status).toBe(200);
      expect(h.clock.sleep).toHaveBeenCalledWith(11_000); // reset seconds → 11s wait
      expect(h.logger.debug).toHaveBeenCalledWith(
        "ratelimit_quota",
        expect.objectContaining({ limit: 200, remaining: 199, resetSeconds: 11 })
      );
    });

    it("classifies a Retry-After-only 429 by its delay (long → error tier)", async () => {
      const h = harness(tiered());
      // No x-ratelimit-reset; a multi-day Retry-After must still hit the error tier.
      h.fetchImpl.mockResolvedValueOnce(res(429, { "retry-after": "2592000" }));

      const response = await h.fetch("https://api.test");

      expect(response.status).toBe(429);
      expect(h.fetchImpl).toHaveBeenCalledTimes(1); // fail fast, no retry
      expect(h.clock.sleep).not.toHaveBeenCalled();
      expect(eventNames(h.logger.warn)).toContain("ratelimit_failfast");
    });

    it("clears a stale wait cooldown when failing fast on an error-tier 429", async () => {
      const h = harness(
        makeOpts({
          tiers: [
            { maxResetSeconds: 120, action: "wait", maxWaitMs: 1_000, maxRetries: 3 },
            { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: 0 }
          ]
        })
      );
      // A prior short-window response armed a capped wait cooldown still in the future.
      h.state.cooldownUntilMs = h.clock.now() + 60_000;
      h.state.cooldownMaxWaitMs = 1_000;
      h.fetchImpl.mockResolvedValueOnce(res(429, { "x-ratelimit-reset": "2592000" }));

      const response = await h.fetch("https://api.test");

      expect(response.status).toBe(429);
      expect(h.state.cooldownUntilMs).toBe(0); // stale cooldown dropped → next call won't sleep
    });

    it("clears a stale wait cooldown on a non-429 error-tier remaining:0", async () => {
      const h = harness(
        makeOpts({
          tiers: [
            { maxResetSeconds: 120, action: "wait", maxWaitMs: 1_000, maxRetries: 3 },
            { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: 0 }
          ]
        })
      );
      h.state.cooldownUntilMs = h.clock.now() + 60_000; // stale short cooldown
      h.state.cooldownMaxWaitMs = 1_000;
      // A healthy-status response that reports remaining:0 with a long reset → error tier.
      h.fetchImpl.mockResolvedValueOnce(
        res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2592000" })
      );

      await h.fetch("https://api.test");

      expect(h.state.cooldownUntilMs).toBe(0); // error tier must not leave the gate armed
    });
  });

  describe("scope: model", () => {
    function modelHarness() {
      const logger = silentLogger();
      const clock = fakeClock();
      const fetchImpl = vi.fn();
      const store: RateStateStore = new Map();
      const fetch = makeRateLimitFetch("prov", makeOpts({ scope: "model" }), store, {
        logger,
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl
      });
      const call = (model: string) =>
        fetch("https://api.test", { method: "POST", body: JSON.stringify({ model }) });
      return { logger, clock, fetchImpl, store, call, fetch };
    }

    it("gates only the exhausted model, not its siblings", async () => {
      const h = modelHarness();
      h.fetchImpl
        // model A exhausts its bucket
        .mockResolvedValueOnce(
          res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" })
        )
        // model B still has quota
        .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "5" }))
        // model A again (gated, then served)
        .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "5" }));

      await h.call("model-a"); // arms cooldown for bucket A only
      await h.call("model-b"); // different bucket → not gated
      expect(h.clock.sleep).not.toHaveBeenCalled();

      await h.call("model-a"); // bucket A is in cooldown → waits
      expect(h.clock.sleep).toHaveBeenCalledTimes(1);
      expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
      expect(h.store.size).toBe(2); // separate state per model
    });

    it("falls back to the provider bucket when the model can't be parsed", async () => {
      const h = modelHarness();
      h.fetchImpl.mockResolvedValue(res(200, { "x-ratelimit-remaining": "5" }));

      await h.fetch("https://api.test"); // no body → model underivable

      expect(h.store.has("prov")).toBe(true); // keyed by the bare provider id
      expect([...h.store.keys()]).toEqual(["prov"]);
    });

    it("derives the model from a Request input, not just init.body", async () => {
      const h = modelHarness();
      h.fetchImpl.mockResolvedValue(res(200, { "x-ratelimit-remaining": "5" }));

      await h.fetch(
        new Request("https://api.test", {
          method: "POST",
          body: JSON.stringify({ model: "kimi-k2.6" })
        })
      );

      const keys = [...h.store.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toBe("prov"); // a per-model bucket, not the provider fallback
      expect(keys[0]).toContain("kimi-k2.6");
    });

    it("clones a Request input per attempt so a wait-tier retry works", async () => {
      const h = modelHarness();
      h.fetchImpl
        .mockResolvedValueOnce(res(429, { "x-ratelimit-reset": "5" }))
        .mockResolvedValueOnce(res(200, { "x-ratelimit-remaining": "5" }));
      const original = new Request("https://api.test", {
        method: "POST",
        body: JSON.stringify({ model: "gemma-4" })
      });

      const response = await h.fetch(original);

      expect(response.status).toBe(200);
      expect(h.fetchImpl).toHaveBeenCalledTimes(2);
      const inputs = h.fetchImpl.mock.calls.map((c) => c[0] as Request);
      expect(inputs[0]).not.toBe(original); // fresh clone, not the original
      expect(inputs[0]).not.toBe(inputs[1]); // distinct clone per attempt
      expect(original.bodyUsed).toBe(false); // original never consumed
    });

    it("honors an abort signal carried on a Request input", async () => {
      const h = modelHarness();
      h.fetchImpl.mockResolvedValueOnce(
        res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" })
      );
      await h.call("model-a"); // arms cooldown for model-a's bucket
      h.fetchImpl.mockClear();

      const req = new Request("https://api.test", {
        method: "POST",
        body: JSON.stringify({ model: "model-a" }),
        signal: AbortSignal.abort()
      });
      const error = await h.fetch(req).then(
        () => null,
        (e: unknown) => e
      );

      expect((error as Error)?.name).toBe("AbortError");
      expect(h.fetchImpl).not.toHaveBeenCalled(); // aborted during the pre-request gate
    });
  });

  it("shares a single timer across a concurrent burst during cooldown", async () => {
    const logger = silentLogger();
    const clock = fakeClock();
    let release: (() => void) | undefined;
    const sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" })
    );
    fetchImpl.mockImplementation(async () => res(200, { "x-ratelimit-remaining": "5" }));

    const store: RateStateStore = new Map();
    const fetch = makeRateLimitFetch("p", makeOpts(), store, {
      logger,
      now: clock.now,
      sleep,
      fetchImpl
    });

    await fetch("https://api.test"); // arms cooldown, no sleep yet
    expect(sleep).not.toHaveBeenCalled();

    const burst = Promise.all([
      fetch("https://api.test"),
      fetch("https://api.test"),
      fetch("https://api.test"),
      fetch("https://api.test"),
      fetch("https://api.test")
    ]);

    expect(sleep).toHaveBeenCalledTimes(1); // ONE shared timer for all 5

    clock.advance(48_000); // window elapses, so the re-check loop exits on resume
    release?.();
    const responses = await burst;

    expect(sleep).toHaveBeenCalledTimes(1); // still one — no extra timer on re-check
    expect(responses).toHaveLength(5);
    for (const r of responses) {
      expect(r.status).toBe(200);
    }
  });

  it("re-waits when the cooldown window is extended mid-wait (longest wins)", async () => {
    const logger = silentLogger();
    const clock = fakeClock();
    const sleptMs: number[] = [];
    const resolvers: Array<() => void> = [];
    const sleep = vi.fn((ms: number) => {
      sleptMs.push(ms);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { "x-ratelimit-remaining": "5" }));
    const store: RateStateStore = new Map();
    const state = createProviderState();
    state.cooldownUntilMs = clock.now() + 3_000; // armed for a short window
    store.set("p", state);
    const fetch = makeRateLimitFetch("p", makeOpts(), store, {
      logger,
      now: clock.now,
      sleep,
      fetchImpl
    });

    const pending = fetch("https://api.test");
    await flush();
    expect(sleptMs).toEqual([3_000]); // first wait sized to the initial window

    // While the caller is parked on the first timer, another response extends
    // the window. The loop must re-check and wait the remainder, not return early.
    state.cooldownUntilMs = clock.now() + 8_000;
    clock.advance(3_000);
    resolvers[0]?.();
    await flush();
    expect(sleptMs).toEqual([3_000, 5_000]); // re-checked → waited the extra 5s

    clock.advance(5_000);
    resolvers[1]?.();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not hold a shorter-wait caller behind a longer in-flight shared timer", async () => {
    const logger = silentLogger();
    const clock = fakeClock();
    const sleptMs: number[] = [];
    const resolvers: Array<() => void> = [];
    const sleep = vi.fn((ms: number) => {
      sleptMs.push(ms);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { "x-ratelimit-remaining": "5" }));
    const store: RateStateStore = new Map();
    const state = createProviderState();
    state.cooldownUntilMs = clock.now() + 100_000; // long window
    store.set("p", state);
    const fetch = makeRateLimitFetch("p", makeOpts(), store, {
      logger,
      now: clock.now,
      sleep,
      fetchImpl
    });

    const longCaller = fetch("https://api.test"); // creates the 100s shared timer
    await flush();
    expect(sleptMs).toEqual([100_000]);

    // The window shrinks; a caller that joins now only needs 2s and must NOT be
    // forced to await the in-flight 100s shared timer.
    state.cooldownUntilMs = clock.now() + 2_000;
    const shortCaller = fetch("https://api.test");
    await flush();
    expect(sleptMs).toEqual([100_000, 2_000]); // its own 2s sleep, not the 100s one

    clock.advance(2_000);
    resolvers[1]?.(); // resolve the short caller's private timer
    expect((await shortCaller).status).toBe(200); // completes without waiting 100s

    clock.advance(98_000);
    resolvers[0]?.();
    await longCaller;
  });

  it("aborts a wait cleanly when the request signal is already aborted", async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(
      res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" })
    );

    await h.fetch("https://api.test"); // arms cooldown
    h.fetchImpl.mockClear();

    const signal = AbortSignal.abort();
    const error = await h.fetch("https://api.test", { signal }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(eventNames(h.logger.warn)).toContain("ratelimit_wait_aborted");
  });

  it("delegates to a pre-existing fetch instead of the global", async () => {
    const logger = silentLogger();
    const clock = fakeClock();
    const fetchImpl = vi.fn();
    const delegate = vi.fn(async () => res(200, { "x-ratelimit-remaining": "5" }));
    const fetch = makeRateLimitFetch(
      "p",
      makeOpts(),
      new Map(),
      { logger, now: clock.now, sleep: clock.sleep, fetchImpl },
      delegate
    );

    await fetch("https://api.test");

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("installRateLimiter", () => {
  function deps(): RateLimitDeps {
    return { logger: silentLogger(), fetchImpl: vi.fn() };
  }

  it("wraps options.fetch for an opted-in provider and logs", () => {
    const d = deps();
    const config: InstallConfigInput = {
      provider: { p: { options: { baseURL: "https://x.test", meta: { rateLimit: {} } } } }
    };

    installRateLimiter(config, d);

    expect(typeof config.provider?.p?.options?.fetch).toBe("function");
    expect(eventNames(d.logger.info)).toContain("ratelimit_provider_enabled");
    expect(eventNames(d.logger.info)).toContain("ratelimit_plugin_initialized");
  });

  it("leaves non-opted-in providers untouched", () => {
    const d = deps();
    const config: InstallConfigInput = {
      provider: { p: { options: { baseURL: "https://x.test" } } }
    };

    installRateLimiter(config, d);

    expect(config.provider?.p?.options?.fetch).toBeUndefined();
    expect(eventNames(d.logger.debug)).toContain("ratelimit_provider_skipped");
  });

  it("captures a pre-existing fetch as the delegate", async () => {
    const d = deps();
    const delegate = vi.fn(async () => res(200, { "x-ratelimit-remaining": "5" }));
    const config: InstallConfigInput = {
      provider: { p: { options: { meta: { rateLimit: {} }, fetch: delegate } } }
    };

    installRateLimiter(config, d);
    const wrapped = config.provider?.p?.options?.fetch as typeof fetch;
    await wrapped("https://api.test");

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });
});
