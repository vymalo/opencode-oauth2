import { afterEach, describe, expect, it, vi } from "vitest";

import { createJsonConsoleLogger, fromOpenCodeLogLevel } from "../src/logging.js";

afterEach(() => vi.restoreAllMocks());

describe("createJsonConsoleLogger", () => {
  it("emits structured JSON to the matching console channel", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createJsonConsoleLogger("debug");

    logger.info("an_event", { a: 1 });
    logger.warn("warn_event");
    logger.error("err_event");

    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      level: "info",
      event: "an_event",
      a: 1
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it("filters events below the minimum level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createJsonConsoleLogger("warn");
    logger.debug("d");
    logger.info("i");
    expect(log).not.toHaveBeenCalled();
  });

  it("redacts secret-ish fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createJsonConsoleLogger("debug").info("e", {
      token: "abc",
      authorization: "Bearer z",
      safe: "ok"
    });
    const payload = JSON.parse(log.mock.calls[0][0] as string);
    expect(payload.token).toBe("[redacted]");
    expect(payload.authorization).toBe("[redacted]");
    expect(payload.safe).toBe("ok");
  });
});

describe("fromOpenCodeLogLevel", () => {
  it("maps known host levels case-insensitively", () => {
    expect(fromOpenCodeLogLevel("DEBUG")).toBe("debug");
    expect(fromOpenCodeLogLevel("info")).toBe("info");
    expect(fromOpenCodeLogLevel("Warn")).toBe("warn");
    expect(fromOpenCodeLogLevel("ERROR")).toBe("error");
  });

  it("returns undefined for unknown or non-string input", () => {
    expect(fromOpenCodeLogLevel("verbose")).toBeUndefined();
    expect(fromOpenCodeLogLevel(42)).toBeUndefined();
  });
});
