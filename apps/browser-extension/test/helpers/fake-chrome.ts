/**
 * A minimal, stable fake of the `chrome.*` surface the background modules use,
 * for unit-testing them under Vitest's node environment (no real browser).
 *
 * The chrome object and its method references are created ONCE and never
 * replaced — only the backing `state` is reset between tests — so module-level
 * captures like `const sidePanelApi = chrome.sidePanel` in the modules under
 * test stay valid after a reset.
 */

type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown;

interface FakeState {
  badgeText: string;
  sidePanelSetOptions: Array<Record<string, unknown>>;
  panelBehavior: Array<{ openPanelOnActionClick: boolean }>;
  activatedTabs: number[];
  removedTabs: number[];
  tabIdSeq: number;
  focusedWindows: number[];
  captures: number;
  /** Make captureVisibleTab reject (simulate an un-capturable page). */
  captureShouldFail: boolean;
  /** Make scripting.executeScript reject (simulate an overlay-blocked page). */
  executeShouldFail: boolean;
  /** Value returned as the injected function's result. */
  executeResult: unknown;
  messageListeners: Set<Listener>;
}

export const chromeState: FakeState = {
  badgeText: "",
  sidePanelSetOptions: [],
  panelBehavior: [],
  activatedTabs: [],
  removedTabs: [],
  tabIdSeq: 100,
  focusedWindows: [],
  captures: 0,
  captureShouldFail: false,
  executeShouldFail: false,
  executeResult: { ok: true },
  messageListeners: new Set()
};

export function resetChromeState(): void {
  chromeState.badgeText = "";
  chromeState.sidePanelSetOptions = [];
  chromeState.panelBehavior = [];
  chromeState.activatedTabs = [];
  chromeState.removedTabs = [];
  chromeState.tabIdSeq = 100;
  chromeState.focusedWindows = [];
  chromeState.captures = 0;
  chromeState.captureShouldFail = false;
  chromeState.executeShouldFail = false;
  chromeState.executeResult = { ok: true };
  chromeState.messageListeners = new Set();
}

/** Simulate an inbound runtime message (e.g. the overlay/panel posting a result). */
export function emitMessage(message: unknown): void {
  for (const listener of [...chromeState.messageListeners]) {
    listener(message, {}, () => {});
  }
}

const fakeChrome = {
  runtime: {
    onMessage: {
      addListener: (fn: Listener) => chromeState.messageListeners.add(fn),
      removeListener: (fn: Listener) => chromeState.messageListeners.delete(fn)
    },
    sendMessage: (message: unknown): Promise<unknown> => {
      emitMessage(message);
      return Promise.resolve(undefined);
    },
    getURL: (path: string): string => `chrome-extension://fake/${path}`
  },
  action: {
    setBadgeText: ({ text }: { text: string }): Promise<void> => {
      chromeState.badgeText = text;
      return Promise.resolve();
    },
    setBadgeBackgroundColor: (): Promise<void> => Promise.resolve()
  },
  tabs: {
    create: ({ url }: { url?: string; active?: boolean }) => {
      const id = ++chromeState.tabIdSeq;
      return Promise.resolve({
        id,
        windowId: 1,
        status: "complete",
        url: url ?? "about:blank",
        title: ""
      });
    },
    get: (tabId: number) =>
      Promise.resolve({ id: tabId, windowId: 1, status: "complete", url: "https://x", title: "X" }),
    update: (tabId: number) => {
      chromeState.activatedTabs.push(tabId);
      return Promise.resolve({ id: tabId, windowId: 1 });
    },
    remove: (tabId: number): Promise<void> => {
      chromeState.removedTabs.push(tabId);
      return Promise.resolve();
    },
    goBack: (): Promise<void> => Promise.resolve(),
    goForward: (): Promise<void> => Promise.resolve(),
    reload: (): Promise<void> => Promise.resolve(),
    captureVisibleTab: (): Promise<string> => {
      chromeState.captures++;
      return chromeState.captureShouldFail
        ? Promise.reject(new Error("cannot capture this page"))
        : Promise.resolve("data:image/png;base64,AAAA");
    }
  },
  windows: {
    update: (windowId: number): Promise<void> => {
      chromeState.focusedWindows.push(windowId);
      return Promise.resolve();
    }
  },
  scripting: {
    executeScript: (): Promise<Array<{ result: unknown }>> =>
      chromeState.executeShouldFail
        ? Promise.reject(new Error("cannot access page"))
        : Promise.resolve([{ result: chromeState.executeResult }])
  },
  sidePanel: {
    setOptions: (opts: Record<string, unknown>): Promise<void> => {
      chromeState.sidePanelSetOptions.push(opts);
      return Promise.resolve();
    },
    setPanelBehavior: (behavior: { openPanelOnActionClick: boolean }): Promise<void> => {
      chromeState.panelBehavior.push(behavior);
      return Promise.resolve();
    }
  },
  cookies: {
    getAll: (): Promise<unknown[]> => Promise.resolve([]),
    set: (): Promise<unknown> => Promise.resolve({}),
    remove: (): Promise<unknown> => Promise.resolve({})
  }
};

/** Install the fake on globalThis.chrome (idempotent — same object every call). */
export function installFakeChrome(): void {
  (globalThis as unknown as { chrome: typeof fakeChrome }).chrome = fakeChrome;
}
