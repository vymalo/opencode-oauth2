import type { BrowserAction } from "./protocol";

/**
 * How the extension drives the page.
 * - `"auto"`    — CDP on Chromium when the debugger attaches, else content-script.
 * - `"cdp"`     — force the Chrome DevTools Protocol executor (Chromium only).
 * - `"content"` — force the synthetic-event content-script executor (Firefox-safe).
 */
export type ExecutorMode = "auto" | "cdp" | "content";

/** Which executor actually serviced a command. */
export type ExecutorKind = "cdp" | "content";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Persisted connection settings (single row). */
export interface Settings {
  id: "singleton";
  bridgeUrl: string;
  token: string;
  executorMode: ExecutorMode;
  /** Stable per-install id advertised to the broker as a routing target. */
  browserId: string;
  /** User-editable label for this browser (defaults to the id). */
  label: string;
}

export const DEFAULT_SETTINGS: Settings = {
  id: "singleton",
  bridgeUrl: "ws://127.0.0.1:4517",
  token: "",
  executorMode: "auto",
  browserId: "",
  label: ""
};

/** Live status the background publishes for the UI to render. */
export interface Status {
  id: "singleton";
  state: ConnectionState;
  lastError?: string;
  connectedAt?: number;
  /** Executor chosen for this browser (resolved from mode + capabilities). */
  executor?: ExecutorKind;
}

/** One row per browser action performed, for the activity timeline. */
export interface ActionRecord {
  id?: number;
  ts: number;
  group: string;
  action: BrowserAction;
  ok: boolean;
  summary: string;
  durationMs?: number;
}

/** A captured screenshot, kept for the dashboard gallery. */
export interface ScreenshotRecord {
  id?: number;
  ts: number;
  group: string;
  /** `data:image/png;base64,...` for direct <img> rendering. */
  dataUrl: string;
  width: number;
  height: number;
}

/** A named tab group the extension is tracking. */
export interface GroupRecord {
  name: string;
  tabIds: number[];
  activeTabId?: number;
  /** Chromium tab-group id (absent on Firefox). */
  tabGroupId?: number;
  createdAt: number;
}
