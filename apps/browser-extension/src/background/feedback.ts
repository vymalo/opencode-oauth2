/**
 * Background-side orchestration for `interactive` feedback requests. Owns the
 * timeout, correlation, and attention signal; the page-side overlay (injected
 * by `feedback-overlay`) reports the user's answer via `chrome.runtime.sendMessage`.
 *
 * Flow: paint overlay → flag attention (badge + focus the tab) → await either a
 * result message, the timeout, or a `cancel()` (broker abandoned the command).
 * Whatever ends it, the overlay is torn down and the attention flag cleared.
 */
import {
  type FeedbackAnnotation,
  type FeedbackMessage,
  type FeedbackRequest,
  hideFeedbackOverlay,
  showFeedbackOverlay
} from "./feedback-overlay";

export interface FeedbackResult {
  responded: boolean;
  timedOut?: boolean;
  /** The overlay couldn't be shown (restricted/CSP page) — distinct from timeout. */
  error?: string;
  annotations: FeedbackAnnotation[];
}

export interface FeedbackHandle {
  /** Resolves when the user answers, the request times out, or it's cancelled. */
  result: Promise<FeedbackResult>;
  /** Broker abandoned the command — tear down the overlay and settle. */
  cancel: () => void;
}

function isFeedbackMessage(msg: unknown, id: string): msg is FeedbackMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "ocb-feedback-result" &&
    (msg as { id?: unknown }).id === id
  );
}

let attentionCount = 0;

/** Raise the toolbar badge and bring the driven tab forward. */
async function flagAttention(tabId: number): Promise<void> {
  attentionCount++;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    await chrome.action.setBadgeText({ text: "?" });
  } catch {
    /* action API unavailable */
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    /* tab/window gone */
  }
}

/** Clear the badge once no feedback requests are outstanding. */
async function clearAttention(): Promise<void> {
  attentionCount = Math.max(0, attentionCount - 1);
  if (attentionCount > 0) {
    return;
  }
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    /* action API unavailable */
  }
}

/**
 * Start a feedback request: paint the overlay, signal attention, and return a
 * handle whose `result` settles exactly once.
 */
export function startFeedback(tabId: number, id: string, req: FeedbackRequest): FeedbackHandle {
  let settle: (r: FeedbackResult) => void = () => {};
  const result = new Promise<FeedbackResult>((resolve) => {
    settle = resolve;
  });

  let done = false;
  const timer = setTimeout(
    () => finish({ responded: false, timedOut: true, annotations: [] }),
    req.timeoutMs
  );

  const onMessage = (msg: unknown): void => {
    if (isFeedbackMessage(msg, id)) {
      finish({ responded: msg.responded, annotations: msg.annotations ?? [] });
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  function finish(r: FeedbackResult): void {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    chrome.runtime.onMessage.removeListener(onMessage);
    void hideFeedbackOverlay(tabId, id);
    void clearAttention();
    settle(r);
  }

  void flagAttention(tabId);
  // Injection failure (e.g. a restricted or CSP-locked page) ends the request
  // immediately with a distinct error rather than hanging until the timeout, so
  // the agent can fall back to a screenshot instead of silently re-asking.
  void showFeedbackOverlay(tabId, id, req).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : "the overlay could not be shown";
    finish({ responded: false, error: reason, annotations: [] });
  });

  return {
    result,
    cancel: () => finish({ responded: false, annotations: [] })
  };
}
