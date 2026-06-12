import type { Status } from "./types";

/** Messages the UI (popup/dashboard) sends to the background worker. */
export type UiMessage = { type: "reconnect" } | { type: "disconnect" } | { type: "get_status" };

export interface UiMessageResponse {
  status: Status;
}
