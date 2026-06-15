import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createJsonConsoleLogger,
  fromOpenCodeLogLevel,
  LOG_LEVEL_PRIORITY
} from "../src/logging.js";

describe("fromOpenCodeLogLevel", () => {
  it("maps DEBUG to the most-verbose trace tier", () => {
    expect(fromOpenCodeLogLevel("DEBUG")).toBe("trace");
    expect(fromOpenCodeLogLevel("debug")).toBe("trace");
  });

  it("maps the remaining host levels straight through", () => {
    expect(fromOpenCodeLogLevel("INFO")).toBe("info");
    expect(fromOpenCodeLogLevel("WARN")).toBe("warn");
    expect(fromOpenCodeLogLevel("ERROR")).toBe("error");
  });

  it("returns undefined for unknown / non-string input", () => {
    expect(fromOpenCodeLogLevel("VERBOSE")).toBeUndefined();
    expect(fromOpenCodeLogLevel(42)).toBeUndefined();
    expect(fromOpenCodeLogLevel(undefined)).toBeUndefined();
  });
});

describe("LOG_LEVEL_PRIORITY", () => {
  it("ranks trace below debug (most verbose)", () => {
    expect(LOG_LEVEL_PRIORITY.trace).toBeLessThan(LOG_LEVEL_PRIORITY.debug);
  });
});

describe("createJsonConsoleLogger trace tier", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a trace event when minLevel is trace", () => {
    const logger = createJsonConsoleLogger("trace");
    logger.trace("ratelimit_fetch_invoked", { providerId: "p" });
    expect(console.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({
      level: "trace",
      event: "ratelimit_fetch_invoked",
      providerId: "p"
    });
  });

  it("suppresses a trace event when minLevel is debug", () => {
    const logger = createJsonConsoleLogger("debug");
    logger.trace("ratelimit_fetch_invoked");
    expect(console.log).not.toHaveBeenCalled();
    // but debug still emits at the debug floor
    logger.debug("ratelimit_quota");
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("redacts sensitive fields on trace events too", () => {
    const logger = createJsonConsoleLogger("trace");
    logger.trace("ratelimit_fetch_invoked", { authorization: "Bearer abc" });
    const payload = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload.authorization).toBe("[redacted]");
  });
});
