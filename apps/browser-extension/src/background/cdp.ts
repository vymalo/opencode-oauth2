/**
 * Thin promise wrapper over `chrome.debugger`. The Chrome DevTools Protocol is
 * the only way to deliver *trusted* input events (real `isTrusted` clicks and
 * key presses that sites can't distinguish from a human) and to capture beyond
 * the viewport. Attaching shows Chrome's "being debugged" banner on the tab —
 * that's an intentional, visible signal that automation is active.
 */

import type { ConsoleEntry, NetworkEntry } from "./executor";

function lastError(): string | undefined {
  return chrome.runtime.lastError?.message;
}

const BUFFER_CAP = 100;

export class CdpSession {
  private readonly attached = new Set<number>();
  private readonly consoleBuf = new Map<number, ConsoleEntry[]>();
  private readonly networkBuf = new Map<number, NetworkEntry[]>();
  private readonly inflight = new Map<number, Map<string, NetworkEntry>>();

  constructor() {
    // If the user dismisses the "being debugged" banner (or the tab crashes),
    // Chrome detaches us out-of-band — drop our cached state so the next call
    // re-attaches instead of failing with "Detached while handling command".
    chrome.debugger?.onDetach?.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
        this.consoleBuf.delete(source.tabId);
        this.networkBuf.delete(source.tabId);
        this.inflight.delete(source.tabId);
      }
    });
    // Buffer console + network events so browser_console / browser_network can
    // read recent activity.
    chrome.debugger?.onEvent?.addListener((source, method, params) =>
      this.onCdpEvent(source.tabId, method, params as Record<string, unknown>)
    );
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  getConsole(tabId: number): ConsoleEntry[] {
    return this.consoleBuf.get(tabId) ?? [];
  }

  getNetwork(tabId: number): NetworkEntry[] {
    return this.networkBuf.get(tabId) ?? [];
  }

  private push<T>(map: Map<number, T[]>, tabId: number, entry: T): void {
    const list = map.get(tabId) ?? [];
    list.push(entry);
    if (list.length > BUFFER_CAP) {
      list.splice(0, list.length - BUFFER_CAP);
    }
    map.set(tabId, list);
  }

  private onCdpEvent(
    tabId: number | undefined,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (tabId === undefined) {
      return;
    }
    const now = Date.now();
    if (method === "Runtime.consoleAPICalled") {
      const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? [];
      const text = args.map((a) => String(a.value ?? a.description ?? "")).join(" ");
      this.push(this.consoleBuf, tabId, { level: String(params.type ?? "log"), text, ts: now });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      const text = details?.exception?.description ?? details?.text ?? "exception";
      this.push(this.consoleBuf, tabId, { level: "error", text, ts: now });
    } else if (method === "Log.entryAdded") {
      const entry = params.entry as { level?: string; text?: string } | undefined;
      this.push(this.consoleBuf, tabId, {
        level: String(entry?.level ?? "info"),
        text: String(entry?.text ?? ""),
        ts: now
      });
    } else if (method === "Network.requestWillBeSent") {
      const request = params.request as { url?: string; method?: string } | undefined;
      const entry: NetworkEntry = {
        method: String(request?.method ?? "GET"),
        url: String(request?.url ?? ""),
        type: params.type ? String(params.type) : undefined,
        ts: now
      };
      this.push(this.networkBuf, tabId, entry);
      const byId = this.inflight.get(tabId) ?? new Map<string, NetworkEntry>();
      byId.set(String(params.requestId), entry);
      this.inflight.set(tabId, byId);
    } else if (method === "Network.responseReceived") {
      const response = params.response as { status?: number } | undefined;
      const entry = this.inflight.get(tabId)?.get(String(params.requestId));
      if (entry && response) {
        entry.status = response.status;
      }
    }
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
    await this.send(tabId, "Log.enable");
    await this.send(tabId, "Network.enable");
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
