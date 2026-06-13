import { describe, expect, it } from "vitest";

import {
  cdpModifierMask,
  parseChord,
  resolveExecutorKind,
  targetToSelector
} from "../src/background/executor";

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

describe("parseChord", () => {
  it("parses a plain key with no modifiers", () => {
    expect(parseChord("a")).toEqual({
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      key: "a"
    });
  });

  it("parses Control+a", () => {
    const c = parseChord("Control+a");
    expect(c.key).toBe("a");
    expect(c.modifiers.ctrl).toBe(true);
  });

  it("parses Meta+Shift+p", () => {
    const c = parseChord("Meta+Shift+p");
    expect(c.key).toBe("p");
    expect(c.modifiers.meta).toBe(true);
    expect(c.modifiers.shift).toBe(true);
  });

  it("treats a lone + as the key itself", () => {
    expect(parseChord("+").key).toBe("+");
  });
});

describe("cdpModifierMask", () => {
  const none = { ctrl: false, alt: false, shift: false, meta: false };
  it("encodes ctrl as 2", () => {
    expect(cdpModifierMask({ ...none, ctrl: true })).toBe(2);
  });
  it("encodes ctrl+shift as 10", () => {
    expect(cdpModifierMask({ ...none, ctrl: true, shift: true })).toBe(10);
  });
  it("encodes alt+meta as 5", () => {
    expect(cdpModifierMask({ ...none, alt: true, meta: true })).toBe(5);
  });
});
