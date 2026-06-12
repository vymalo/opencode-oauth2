import { defineBackground } from "#imports";

import { BridgeClient } from "../background/bridge-client";
import { CdpExecutor } from "../background/cdp-executor";
import { CommandRouter } from "../background/command-router";
import { ContentExecutor } from "../background/content-executor";
import { detectCapabilities, type Executor, resolveExecutorKind } from "../background/executor";
import { GroupRegistry } from "../background/group-registry";
import { getSettings, getStatus } from "../shared/db";
import type { UiMessage, UiMessageResponse } from "../shared/messages";
import type { ExecutorKind } from "../shared/types";

export default defineBackground(() => {
  let executor: Executor = new ContentExecutor();
  let registry = new GroupRegistry(executor);
  let router = new CommandRouter(registry, executor);
  let executorKind: ExecutorKind = "content";

  // Rebuild the executor stack from current settings. Called at boot and after
  // the user changes settings (executor mode may have flipped).
  async function rebuild(): Promise<void> {
    const settings = await getSettings();
    executorKind = resolveExecutorKind(settings.executorMode, detectCapabilities());
    executor = executorKind === "cdp" ? new CdpExecutor() : new ContentExecutor();
    registry = new GroupRegistry(executor);
    router = new CommandRouter(registry, executor);
  }

  const client = new BridgeClient({
    getConfig: async () => {
      const s = await getSettings();
      return { url: s.bridgeUrl, token: s.token };
    },
    onCommand: (frame) => router.handle(frame),
    executorKind: () => executorKind,
    clientName: `opencode-browser-ext/${import.meta.env.BROWSER}`
  });

  // Boot: build the stack, then dial the bridge.
  void (async () => {
    await rebuild();
    await client.connect();
  })();

  // Control channel from the popup / dashboard.
  chrome.runtime.onMessage.addListener((message: UiMessage, _sender, sendResponse) => {
    void (async () => {
      if (message.type === "reconnect") {
        await rebuild();
        await client.reconnect();
      } else if (message.type === "disconnect") {
        client.disconnect();
      }
      const status = await getStatus();
      sendResponse({ status } satisfies UiMessageResponse);
    })();
    return true; // keep the message channel open for the async response
  });

  // Keep the registry honest when the user closes a driven tab by hand.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void registry.forget(tabId);
  });
});
