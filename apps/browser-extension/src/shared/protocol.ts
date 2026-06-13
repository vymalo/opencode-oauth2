/**
 * Wire protocol shared by the OpenCode plugin (the bridge **server**) and this
 * browser extension (the **client**). This module is intentionally
 * dependency-free and runtime-agnostic.
 *
 * CANONICAL COPY lives in the plugin at
 * `packages/opencode-browser/src/protocol.ts`. This is a byte-for-byte mirror —
 * keep the two in sync when the frame shapes change.
 */

/** Bump when the frame shapes change incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Every browser action the plugin can ask the extension to perform. */
export type BrowserAction =
  | "open"
  | "navigate"
  | "click"
  | "double_click"
  | "type"
  | "fill"
  | "select"
  | "scroll"
  | "press_key"
  | "screenshot"
  | "snapshot"
  | "get_text"
  | "wait"
  | "tabs"
  | "close"
  | "back"
  | "forward"
  | "reload"
  | "hover"
  | "activate"
  | "drag"
  | "upload"
  | "get_html"
  | "get_attribute"
  | "query"
  | "eval"
  | "console"
  | "network"
  | "handle_dialog"
  | "set_viewport"
  | "cookies"
  | "targets"
  | "release";

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  "open",
  "navigate",
  "click",
  "double_click",
  "type",
  "fill",
  "select",
  "scroll",
  "press_key",
  "screenshot",
  "snapshot",
  "get_text",
  "wait",
  "tabs",
  "close",
  "back",
  "forward",
  "reload",
  "hover",
  "activate",
  "drag",
  "upload",
  "get_html",
  "get_attribute",
  "query",
  "eval",
  "console",
  "network",
  "handle_dialog",
  "set_viewport",
  "cookies",
  "targets",
  "release"
] as const;

/** A connection's role on the bridge. Absent → "extension" (back-compat). */
export type ClientRole = "agent" | "extension";

/** Client → broker: first frame after the socket opens. */
export interface HelloFrame {
  v: number;
  type: "hello";
  token: string;
  role?: ClientRole;
  client?: string;
  /** Extensions: stable per-install id, usable as a routing target. */
  id?: string;
  /** Extensions: user-editable label from the dashboard. */
  label?: string;
  /** Extensions: "chrome" | "firefox" | UA hint. */
  browser?: string;
}

/** Broker → client: handshake accepted. */
export interface ReadyFrame {
  v: number;
  type: "ready";
  server: "opencode-browser";
  protocol: number;
  role?: ClientRole;
  clientId?: string;
  executor?: "auto" | "cdp" | "content";
}

/** Server → extension: perform an action, expect a matching `result`. */
export interface CommandFrame {
  v: number;
  type: "command";
  id: string;
  action: BrowserAction;
  group: string;
  params: Record<string, unknown>;
  /** Broker-only executor selector; ignored by executors. */
  target?: string;
}

/** Extension → server: response to a `command`. */
export interface ResultFrame {
  v: number;
  type: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string };
}

export type BrowserEventName = "tab_closed" | "navigated" | "group_removed" | "tab_created";

/** Extension → server: unsolicited notification. */
export interface EventFrame {
  v: number;
  type: "event";
  name: BrowserEventName;
  group?: string;
  data?: Record<string, unknown>;
}

/** Server → extension: release control (detach the debugger) without closing tabs. */
export interface ReleaseFrame {
  v: number;
  type: "release";
}

export interface PingFrame {
  v: number;
  type: "ping";
}

export interface PongFrame {
  v: number;
  type: "pong";
}

export type Frame =
  | HelloFrame
  | ReadyFrame
  | CommandFrame
  | ResultFrame
  | EventFrame
  | ReleaseFrame
  | PingFrame
  | PongFrame;

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeFrame(raw: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }
  switch (parsed.type) {
    case "hello":
      return typeof parsed.token === "string" ? (parsed as unknown as HelloFrame) : null;
    case "ready":
      return parsed as unknown as ReadyFrame;
    case "command":
      return typeof parsed.id === "string" &&
        typeof parsed.action === "string" &&
        typeof parsed.group === "string"
        ? (parsed as unknown as CommandFrame)
        : null;
    case "result":
      return typeof parsed.id === "string" && typeof parsed.ok === "boolean"
        ? (parsed as unknown as ResultFrame)
        : null;
    case "event":
      return typeof parsed.name === "string" ? (parsed as unknown as EventFrame) : null;
    case "release":
      return { v: PROTOCOL_VERSION, type: "release" };
    case "ping":
      return { v: PROTOCOL_VERSION, type: "ping" };
    case "pong":
      return { v: PROTOCOL_VERSION, type: "pong" };
    default:
      return null;
  }
}

export function helloFrame(
  token: string,
  opts: { role?: ClientRole; client?: string; id?: string; label?: string; browser?: string } = {}
): HelloFrame {
  return { v: PROTOCOL_VERSION, type: "hello", token, ...opts };
}

export function resultFrame(id: string, data: unknown): ResultFrame {
  return { v: PROTOCOL_VERSION, type: "result", id, ok: true, data };
}

export function errorFrame(id: string, message: string, code?: string): ResultFrame {
  return { v: PROTOCOL_VERSION, type: "result", id, ok: false, error: { message, code } };
}

export function eventFrame(
  name: BrowserEventName,
  group?: string,
  data?: Record<string, unknown>
): EventFrame {
  return { v: PROTOCOL_VERSION, type: "event", name, group, data };
}
