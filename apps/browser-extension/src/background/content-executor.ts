import type { Executor, ScreenshotData } from "./executor";
import {
  pageSyntheticKey,
  pageSyntheticPointer,
  pageSyntheticType,
  type Target,
  runInPage
} from "./page-actions";

/**
 * Fallback executor: synthetic DOM events injected into the page plus
 * `tabs.captureVisibleTab` for screenshots. No "being debugged" banner and it
 * works on Firefox, but clicks aren't trusted (`isTrusted: false`) and capture
 * is limited to the visible viewport.
 */
export class ContentExecutor implements Executor {
  readonly kind = "content" as const;

  async click(tabId: number, target: Target, _button: "left" | "middle" | "right"): Promise<void> {
    const ok = await runInPage(tabId, pageSyntheticPointer, [{ ...target, dblclick: false }]);
    if (!ok) {
      throw new Error("could not locate the target element");
    }
  }

  async doubleClick(tabId: number, target: Target): Promise<void> {
    const ok = await runInPage(tabId, pageSyntheticPointer, [{ ...target, dblclick: true }]);
    if (!ok) {
      throw new Error("could not locate the target element");
    }
  }

  async type(tabId: number, text: string, target: Target, submit: boolean): Promise<void> {
    const ok = await runInPage(tabId, pageSyntheticType, [
      { text, ref: target.ref, selector: target.selector, submit }
    ]);
    if (!ok) {
      throw new Error("no focusable element to type into");
    }
  }

  async pressKey(tabId: number, key: string): Promise<void> {
    await runInPage(tabId, pageSyntheticKey, [{ key }]);
  }

  async screenshot(tabId: number, _fullPage: boolean): Promise<ScreenshotData> {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined) {
      throw new Error("tab has no window");
    }
    // captureVisibleTab grabs the active tab of the window — make sure it's ours.
    // Activation + paint is async, so wait briefly or we'd capture the prior tab.
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const size = await runInPage(
      tabId,
      () => ({ w: window.innerWidth, h: window.innerHeight }),
      []
    );
    return { base64, width: size?.w ?? 0, height: size?.h ?? 0 };
  }

  async release(_tabId: number): Promise<void> {
    // Nothing to release — no persistent attachment.
  }

  async releaseAll(): Promise<void> {
    // No persistent attachments.
  }
}
