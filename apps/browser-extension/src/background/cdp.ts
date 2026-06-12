/**
 * Thin promise wrapper over `chrome.debugger`. The Chrome DevTools Protocol is
 * the only way to deliver *trusted* input events (real `isTrusted` clicks and
 * key presses that sites can't distinguish from a human) and to capture beyond
 * the viewport. Attaching shows Chrome's "being debugged" banner on the tab —
 * that's an intentional, visible signal that automation is active.
 */

function lastError(): string | undefined {
  return chrome.runtime.lastError?.message;
}

export class CdpSession {
  private readonly attached = new Set<number>();

  constructor() {
    // If the user dismisses the "being debugged" banner (or the tab crashes),
    // Chrome detaches us out-of-band — drop our cached state so the next call
    // re-attaches instead of failing with "Detached while handling command".
    chrome.debugger?.onDetach?.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
      }
    });
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = lastError();
        if (err) {
          reject(new Error(`debugger attach failed: ${err}`));
        } else {
          resolve();
        }
      });
    });
    this.attached.add(tabId);
    await this.send(tabId, "Page.enable");
    await this.send(tabId, "DOM.enable");
    await this.send(tabId, "Runtime.enable");
  }

  send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
        const err = lastError();
        if (err) {
          reject(new Error(`${method} failed: ${err}`));
        } else {
          resolve(result as T);
        }
      });
    });
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) {
      return;
    }
    this.attached.delete(tabId);
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        // Swallow errors — the tab may already be gone.
        void lastError();
        resolve();
      });
    });
  }

  /** Detach every attached tab — used when the executor stack is replaced. */
  async detachAll(): Promise<void> {
    await Promise.all([...this.attached].map((tabId) => this.detach(tabId)));
  }
}

/** CDP key descriptors for the handful of named keys we special-case. */
export const KEY_CODES: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 }
};
