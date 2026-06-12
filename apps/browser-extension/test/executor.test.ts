import { describe, expect, it } from "vitest";

import { resolveExecutorKind, targetToSelector } from "../src/background/executor";

describe("resolveExecutorKind", () => {
  const withDebugger = { hasDebugger: true };
  const noDebugger = { hasDebugger: false };

  it("auto prefers CDP when the debugger is available", () => {
    expect(resolveExecutorKind("auto", withDebugger)).toBe("cdp");
  });

  it("auto falls back to content without the debugger", () => {
    expect(resolveExecutorKind("auto", noDebugger)).toBe("content");
  });

  it("content is always content", () => {
    expect(resolveExecutorKind("content", withDebugger)).toBe("content");
    expect(resolveExecutorKind("content", noDebugger)).toBe("content");
  });

  it("cdp downgrades to content when the debugger is missing (Firefox forcing cdp)", () => {
    expect(resolveExecutorKind("cdp", withDebugger)).toBe("cdp");
    expect(resolveExecutorKind("cdp", noDebugger)).toBe("content");
  });
});

describe("targetToSelector", () => {
  it("maps a ref to its data-attribute selector", () => {
    expect(targetToSelector({ ref: "e7" })).toBe('[data-ocb-ref="e7"]');
  });

  it("passes a CSS selector through", () => {
    expect(targetToSelector({ selector: "#submit" })).toBe("#submit");
  });

  it("returns null for coordinate-only targets", () => {
    expect(targetToSelector({ x: 10, y: 20 })).toBeNull();
  });
});
