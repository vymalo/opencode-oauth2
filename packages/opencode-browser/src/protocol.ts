/**
 * Wire protocol shared by the OpenCode plugin (the bridge **server**) and the
 * browser extension (the **client**). This module is intentionally
 * dependency-free and runtime-agnostic so the extension can mirror it verbatim
 * into a browser bundle without pulling in any Bun/Node code.
 *
 * Canonical copy lives here (`packages/opencode-browser/src/protocol.ts`); the
 * extension keeps a byte-for-byte copy at
 * `apps/browser-extension/src/shared/protocol.ts`. Keep them in sync.
 *
 * Topology: extensions cannot host servers, so the plugin opens the WebSocket
 * server on 127.0.0.1 and the extension's background worker dials out to it.
 * The extension authenticates with a `hello`; the server replies `ready`. From
 * then on the server issues `command` frames and the extension answers with a
 * matching `result` frame (correlated by `id`). The extension may also push
 * unsolicited `event` frames. Heartbeats use `ping`/`pong`.
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
  /** Shared secret; must equal the bridge token. */
  token: string;
  /** "extension" (executor) or "agent" (producer). Default extension. */
  role?: ClientRole;
  /** Free-form client descriptor for logging (browser name/version, agent name). */
  client?: string;
  /** Extensions: stable per-install id (persisted), usable as a routing target. */
  id?: string;
  /** Extensions: user-editable label from the dashboard (defaults to id). */
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
  /** Role the broker accepted this connection as. */
  role?: ClientRole;
  /** Id the broker assigned/echoed for this client. */
  clientId?: string;
  /** Operator's executor preference, if configured plugin-side (extensions only). */
  executor?: "auto" | "cdp" | "content";
}

/** Server → extension: perform an action, expect a matching `result`. */
export interface CommandFrame {
  v: number;
  type: "command";
  /** Correlation id; the `result` echoes it. */
  id: string;
  action: BrowserAction;
  /** Named tab group the action targets. */
  group: string;
  /** Action-specific arguments (already validated plugin-side). */
  params: Record<string, unknown>;
  /**
   * Optional executor selector (browser label or id) used by the broker when a
   * command creates a new group; ignored by executors.
   */
  target?: string;
}

/** Extension → server: response to a `command`. */
export interface ResultFrame {
  v: number;
  type: "result";
  id: string;
  ok: boolean;
  /** Present when `ok` is true. */
  data?: unknown;
  /** Present when `ok` is false. */
  error?: { message: string; code?: string };
}

/** Names of unsolicited events the extension can push. */
export type BrowserEventName = "tab_closed" | "navigated" | "group_removed" | "tab_created";

/** Extension → server: unsolicited notification (not correlated to a command). */
export interface EventFrame {
  v: number;
  type: "event";
  name: BrowserEventName;
  group?: string;
  data?: Record<string, unknown>;
}

/**
 * Server → extension: stop driving and release control (detach the CDP
 * debugger) without closing tabs. The next command re-attaches. Lets the plugin
 * hand the browser back without waiting for the socket to drop.
 */
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

/** Serialize a frame for the wire. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse and shape-check an inbound frame. Returns the typed frame, or `null` if
 * the payload is not a recognizable frame (caller decides whether to drop or
 * log). Validation is deliberately lightweight — both ends are trusted once the
 * token handshake succeeds; this guards against malformed JSON and version skew,
 * not a hostile peer.
 */
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

let idCounter = 0;

/**
 * Monotonic correlation id for command frames. Process-local and collision-free
 * within a single bridge instance, which is all that's required (the server is
 * the only id minter).
 */
export function nextId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `c${idCounter.toString(36)}`;
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
