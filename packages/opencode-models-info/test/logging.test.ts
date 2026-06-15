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

  it("maps the remaining host levels unchanged", () => {
    expect(fromOpenCodeLogLevel("INFO")).toBe("info");
    expect(fromOpenCodeLogLevel("WARN")).toBe("warn");
    expect(fromOpenCodeLogLevel("ERROR")).toBe("error");
  });

  it("returns undefined for unknown or non-string values", () => {
    expect(fromOpenCodeLogLevel("VERBOSE")).toBeUndefined();
    expect(fromOpenCodeLogLevel(42)).toBeUndefined();
    expect(fromOpenCodeLogLevel(undefined)).toBeUndefined();
  });
});

describe("LOG_LEVEL_PRIORITY", () => {
  it("ranks trace below debug", () => {
    expect(LOG_LEVEL_PRIORITY.trace).toBeLessThan(LOG_LEVEL_PRIORITY.debug);
  });
});

describe("createJsonConsoleLogger trace tier", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a trace event when minLevel is trace", () => {
    const logger = createJsonConsoleLogger("trace");
    logger.trace("models_info_unit_trace", { count: 1 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.level).toBe("trace");
    expect(payload.event).toBe("models_info_unit_trace");
    expect(payload.count).toBe(1);
  });

  it("suppresses trace events when minLevel is debug", () => {
    const logger = createJsonConsoleLogger("debug");
    logger.trace("models_info_unit_trace", { count: 1 });
    expect(logSpy).not.toHaveBeenCalled();

    // debug at the same minLevel still emits, proving the gate is level-based.
    logger.debug("models_info_unit_debug");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
