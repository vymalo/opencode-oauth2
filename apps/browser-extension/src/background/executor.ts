import type { ExecutorKind, ExecutorMode } from "../shared/types";
import type { Target } from "./page-actions";

export interface ScreenshotData {
  base64: string;
  width: number;
  height: number;
}

/**
 * The trusted-input surface that genuinely differs between backends. Everything
 * else (snapshot, text, scroll, fill, select, wait) is DOM-only and handled
 * uniformly via page-actions, so it isn't part of this interface.
 */
export interface Executor {
  readonly kind: ExecutorKind;
  click(tabId: number, target: Target, button: "left" | "middle" | "right"): Promise<void>;
  doubleClick(tabId: number, target: Target): Promise<void>;
  type(tabId: number, text: string, target: Target, submit: boolean): Promise<void>;
  pressKey(tabId: number, key: string): Promise<void>;
  screenshot(tabId: number, fullPage: boolean): Promise<ScreenshotData>;
  /** Release any per-tab resources (e.g. detach the debugger). Best-effort. */
  release(tabId: number): Promise<void>;
}

export interface BrowserCapabilities {
  /** chrome.debugger present (Chromium). */
  hasDebugger: boolean;
}

export function detectCapabilities(): BrowserCapabilities {
  return {
    hasDebugger: typeof chrome !== "undefined" && typeof chrome.debugger?.attach === "function"
  };
}

/**
 * Decide which executor to use from the configured mode and the browser's
 * capabilities. Pure and total — unit-tested.
 *
 * - `auto`    → CDP when the debugger is available, else content-script.
 * - `cdp`     → CDP (falls back to content if the debugger is missing, so a
 *               Firefox user who forced `cdp` still gets a working executor).
 * - `content` → always content-script.
 */
export function resolveExecutorKind(mode: ExecutorMode, caps: BrowserCapabilities): ExecutorKind {
  if (mode === "content") {
    return "content";
  }
  if (mode === "cdp") {
    return caps.hasDebugger ? "cdp" : "content";
  }
  return caps.hasDebugger ? "cdp" : "content";
}

/** Map a target to a CSS selector, or null for coordinate/active-element targeting. */
export function targetToSelector(target: Target): string | null {
  if (target.ref) {
    return `[data-ocb-ref="${target.ref}"]`;
  }
  if (target.selector) {
    return target.selector;
  }
  return null;
}
