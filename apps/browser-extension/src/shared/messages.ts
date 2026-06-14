import type { Status } from "./types";

/** Messages the UI (popup/dashboard) sends to the background worker. */
export type UiMessage = { type: "reconnect" } | { type: "disconnect" } | { type: "get_status" };

export interface UiMessageResponse {
  status: Status;
}

/**
 * A pending feedback request routed to the **side panel** (the fallback used
 * when the in-page overlay can't be injected — restricted / CSP pages). The
 * panel renders `screenshot` and the mode's controls; coordinates it returns are
 * in captured-screenshot pixels (no live DOM, so no element refs on these pages).
 */
export interface FeedbackSession {
  id: string;
  mode: string;
  prompt?: string;
  options?: string[];
  /** PNG data URL of the tab at request time. */
  screenshot: string;
}

/** Side panel → background: fetch the request awaiting a response (or null). */
export type FeedbackPendingQuery = { type: "feedback:get-pending" };
export interface FeedbackPendingResponse {
  session: FeedbackSession | null;
}

/** Background → side panel (broadcast): the pending request changed. */
export type FeedbackPendingChanged = { type: "feedback:pending-changed" };

/**
 * Side panel / overlay → background: the user's response. Both surfaces post the
 * same shape so the background's per-request listener correlates them uniformly.
 */
export interface FeedbackResultMessage {
  type: "ocb-feedback-result";
  id: string;
  responded: boolean;
  annotations: unknown[];
}
