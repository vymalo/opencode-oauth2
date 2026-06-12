import { CdpSession, KEY_CODES } from "./cdp";
import { cdpModifierMask, type Executor, parseChord, type ScreenshotData } from "./executor";
import { type Center, pageGetCenter, type Target, runInPage } from "./page-actions";

interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  cssVisualViewport?: { clientWidth: number; clientHeight: number };
}

/** Resolve a target to viewport coordinates, preferring explicit x/y. */
async function resolveCenter(tabId: number, target: Target): Promise<Center> {
  if (typeof target.x === "number" && typeof target.y === "number") {
    return { found: true, x: target.x, y: target.y };
  }
  const center = await runInPage(tabId, pageGetCenter, [target]);
  if (!center?.found) {
    throw new Error("could not locate the target element");
  }
  return center;
}

/** Executor backed by the Chrome DevTools Protocol — trusted input + full-page capture. */
export class CdpExecutor implements Executor {
  readonly kind = "cdp" as const;
  private readonly cdp = new CdpSession();

  private async mouse(
    tabId: number,
    x: number,
    y: number,
    button: "left" | "middle" | "right",
    clickCount: number
  ): Promise<void> {
    const base = { x, y, button, clickCount };
    // CDP `buttons` is a bitfield (left=1, right=2, middle=4) — must match the
    // requested button or pages reading event.buttons see the wrong one.
    const buttonsBit = button === "right" ? 2 : button === "middle" ? 4 : 1;
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      buttons: buttonsBit,
      ...base
    });
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      buttons: 0,
      ...base
    });
  }

  async click(tabId: number, target: Target, button: "left" | "middle" | "right"): Promise<void> {
    await this.cdp.attach(tabId);
    const { x, y } = await resolveCenter(tabId, target);
    await this.mouse(tabId, x, y, button, 1);
  }

  async doubleClick(tabId: number, target: Target): Promise<void> {
    await this.cdp.attach(tabId);
    const { x, y } = await resolveCenter(tabId, target);
    await this.mouse(tabId, x, y, "left", 1);
    await this.mouse(tabId, x, y, "left", 2);
  }

  async type(tabId: number, text: string, target: Target, submit: boolean): Promise<void> {
    await this.cdp.attach(tabId);
    if (target.ref || target.selector || (target.x !== undefined && target.y !== undefined)) {
      const { x, y } = await resolveCenter(tabId, target);
      await this.mouse(tabId, x, y, "left", 1); // focus the field
    }
    await this.cdp.send(tabId, "Input.insertText", { text });
    if (submit) {
      await this.pressKey(tabId, "Enter");
    }
  }

  async pressKey(tabId: number, key: string): Promise<void> {
    await this.cdp.attach(tabId);
    const { modifiers, key: baseKey } = parseChord(key);
    const mask = cdpModifierMask(modifiers);
    const descriptor = KEY_CODES[baseKey];
    const single = baseKey.length === 1;
    const common = descriptor
      ? { key: baseKey, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode }
      : {
          key: baseKey,
          windowsVirtualKeyCode: single ? baseKey.toUpperCase().charCodeAt(0) : undefined
        };
    await this.cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: mask,
      ...common
    });
    // Only emit a character when no modifier is held — Control+a must not type "a".
    if (!descriptor && single && mask === 0) {
      await this.cdp.send(tabId, "Input.dispatchKeyEvent", { type: "char", text: baseKey });
    }
    await this.cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: mask,
      ...common
    });
  }

  async screenshot(tabId: number, fullPage: boolean): Promise<ScreenshotData> {
    await this.cdp.attach(tabId);
    const metrics = await this.cdp.send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
    const params: Record<string, unknown> = { format: "png", captureBeyondViewport: fullPage };
    let width = metrics.cssVisualViewport?.clientWidth ?? 1280;
    let height = metrics.cssVisualViewport?.clientHeight ?? 800;
    if (fullPage && metrics.cssContentSize) {
      width = metrics.cssContentSize.width;
      height = metrics.cssContentSize.height;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    const result = await this.cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", params);
    return { base64: result.data, width: Math.round(width), height: Math.round(height) };
  }

  async release(tabId: number): Promise<void> {
    await this.cdp.detach(tabId);
  }

  async releaseAll(): Promise<void> {
    await this.cdp.detachAll();
  }
}
