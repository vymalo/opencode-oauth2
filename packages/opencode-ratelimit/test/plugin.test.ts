import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logging.js";
import {
  createProviderState,
  type InstallConfigInput,
  installRateLimiter,
  makeRateLimitFetch,
  type ProviderRateState,
  type RateLimitDeps
} from "../src/plugin.js";
import type { RateLimitOptions } from "../src/types.js";

const NOW = 1_700_000_000_000;

function silentLogger(): Logger {
  return {
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

function makeOpts(over: Partial<RateLimitOptions> = {}): RateLimitOptions {
  return { enabled: true, maxWaitMs: 0, maxRetries: 5, headerPrefix: "x-ratelimit", ...over };
}

function res(status: number, headers: Record<string, string> = {}, body?: string): Response {
  return new Response(body ?? null, { status, headers });
}

interface Harness {
  logger: Logger;
  clock: ReturnType<typeof fakeClock>;
  fetchImpl: ReturnType<typeof vi.fn>;
  state: ProviderRateState;
  deps: RateLimitDeps;
  fetch: typeof fetch;
}

function harness(opts: RateLimitOptions = makeOpts()): Harness {
  const logger = silentLogger();
  const clock = fakeClock();
  const fetchImpl = vi.fn();
  const state = createProviderState();
  const deps: RateLimitDeps = { logger, now: clock.now, sleep: clock.sleep, fetchImpl };
  const fetch = makeRateLimitFetch("test-provider", opts, state, deps);
  return { logger, clock, fetchImpl, state, deps, fetch };
}

function eventNames(spy: Logger[keyof Logger]): string[] {
  return (spy as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

describe("makeRateLimitFetch", () => {
  it("tracks quota without waiting on a healthy response", async () => {
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
    expect(h.state.remaining).toBe(2);
    expect(h.state.limit).toBe(10);
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

    const state = createProviderState();
    const fetch = makeRateLimitFetch("p", makeOpts(), state, {
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
    release?.();
    const responses = await burst;

    expect(responses).toHaveLength(5);
    for (const r of responses) {
      expect(r.status).toBe(200);
    }
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
      createProviderState(),
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
