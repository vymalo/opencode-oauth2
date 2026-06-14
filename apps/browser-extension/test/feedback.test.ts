import { afterEach, describe, expect, it, vi } from "vitest";

import { getActiveFeedbackSession } from "../src/background/feedback-side-panel";
import { startFeedback } from "../src/background/feedback";
import { chromeState, emitMessage } from "./helpers/fake-chrome";

/** Let queued microtasks (chrome fakes resolve via promises) flush. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function result(id: string, responded: boolean, annotations: unknown[]) {
  return { type: "ocb-feedback-result", id, responded, annotations };
}

describe("startFeedback orchestration", () => {
  it("resolves with the user's response when a result message arrives", async () => {
    const handle = startFeedback(7, "c1", { mode: "confirm", timeoutMs: 60_000 });
    await flush();
    emitMessage(result("c1", true, [{ kind: "confirm", value: true }]));
    await expect(handle.result).resolves.toMatchObject({
      responded: true,
      annotations: [{ kind: "confirm", value: true }]
    });
  });

  it("flags attention (badge + tab activation) while pending and clears it after", async () => {
    const handle = startFeedback(7, "c2", { mode: "confirm", timeoutMs: 60_000 });
    await flush();
    expect(chromeState.badgeText).toBe("?");
    expect(chromeState.activatedTabs).toContain(7);
    handle.cancel();
    await handle.result;
    await flush();
    expect(chromeState.badgeText).toBe("");
  });

  it("ignores result messages for a different command id", async () => {
    const handle = startFeedback(7, "c3", { mode: "confirm", timeoutMs: 60_000 });
    await flush();
    emitMessage(result("other-id", true, [{ kind: "confirm", value: true }]));
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    handle.cancel();
    await handle.result;
  });

  it("cancel() settles as a non-response", async () => {
    const handle = startFeedback(7, "c4", { mode: "confirm", timeoutMs: 60_000 });
    await flush();
    handle.cancel();
    await expect(handle.result).resolves.toMatchObject({ responded: false });
  });

  it("falls back to the side panel when overlay injection fails, then resolves", async () => {
    chromeState.executeShouldFail = true; // overlay can't inject (restricted page)
    const handle = startFeedback(7, "c5", { mode: "point", timeoutMs: 60_000 });
    await flush();
    expect(getActiveFeedbackSession()?.id).toBe("c5"); // routed to the panel
    expect(chromeState.captures).toBe(1);
    emitMessage(result("c5", true, [{ kind: "point", x: 5, y: 6 }]));
    await expect(handle.result).resolves.toMatchObject({ responded: true });
  });

  it("errors when neither the overlay nor a screenshot can be obtained", async () => {
    chromeState.executeShouldFail = true;
    chromeState.captureShouldFail = true;
    const handle = startFeedback(7, "c6", { mode: "point", timeoutMs: 60_000 });
    await expect(handle.result).resolves.toMatchObject({
      responded: false,
      error: expect.any(String)
    });
  });
});

describe("startFeedback timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("settles as timedOut when no one responds", async () => {
    vi.useFakeTimers();
    const handle = startFeedback(7, "c7", { mode: "confirm", timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(handle.result).resolves.toMatchObject({ responded: false, timedOut: true });
  });
});
