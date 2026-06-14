import { beforeEach } from "vitest";

import { installFakeChrome, resetChromeState } from "./fake-chrome";

// Install the fake chrome BEFORE any module-under-test is imported (so top-level
// captures like `const sidePanelApi = chrome.sidePanel` resolve), and reset its
// backing state before each test. The object identity never changes.
installFakeChrome();
beforeEach(() => {
  installFakeChrome();
  resetChromeState();
});
