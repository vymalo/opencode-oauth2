import { afterEach, describe, expect, it } from "vitest";

import {
  clearFeedbackSession,
  getActiveFeedbackSession,
  openSidePanelFallback
} from "../src/background/feedback-side-panel";
import { chromeState } from "./helpers/fake-chrome";

describe("feedback side-panel session store", () => {
  afterEach(() => {
    const s = getActiveFeedbackSession();
    if (s) {
      clearFeedbackSession(s.id);
    }
  });

  it("has no active session initially", () => {
    expect(getActiveFeedbackSession()).toBeNull();
  });

  it("captures a screenshot and enables the panel on fallback", async () => {
    const ok = await openSidePanelFallback(7, "c1", { mode: "point", prompt: "where?" });
    expect(ok).toBe(true);
    expect(getActiveFeedbackSession()).toMatchObject({
      id: "c1",
      mode: "point",
      prompt: "where?",
      screenshot: "data:image/png;base64,AAAA"
    });
    expect(chromeState.captures).toBe(1);
    expect(chromeState.sidePanelSetOptions[0]).toMatchObject({ tabId: 7, enabled: true });
    expect(chromeState.panelBehavior).toContainEqual({ openPanelOnActionClick: true });
  });

  it("returns false and stores no session when the screenshot fails", async () => {
    chromeState.captureShouldFail = true;
    const ok = await openSidePanelFallback(7, "c2", { mode: "confirm" });
    expect(ok).toBe(false);
    expect(getActiveFeedbackSession()).toBeNull();
  });

  it("clears the session, restores popup behavior, and retires the panel", async () => {
    await openSidePanelFallback(9, "c3", { mode: "region" });
    clearFeedbackSession("c3");
    expect(getActiveFeedbackSession()).toBeNull();
    expect(chromeState.panelBehavior).toContainEqual({ openPanelOnActionClick: false });
    expect(chromeState.sidePanelSetOptions).toContainEqual({ tabId: 9, enabled: false });
  });

  it("ignores clearing a non-matching id", async () => {
    await openSidePanelFallback(7, "c4", { mode: "point" });
    clearFeedbackSession("does-not-match");
    expect(getActiveFeedbackSession()?.id).toBe("c4");
  });
});
