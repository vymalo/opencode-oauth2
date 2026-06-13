import { defineBackground } from "#imports";

import { BridgeClient } from "../background/bridge-client";
import { CdpExecutor } from "../background/cdp-executor";
import { CommandRouter } from "../background/command-router";
import { ContentExecutor } from "../background/content-executor";
import { detectCapabilities, type Executor, resolveExecutorKind } from "../background/executor";
import { GroupRegistry } from "../background/group-registry";
import { getSettings, getStatus, saveSettings, setStatus } from "../shared/db";
import type { UiMessage, UiMessageResponse } from "../shared/messages";
import type { ExecutorKind, ExecutorMode } from "../shared/types";

export default defineBackground(() => {
  let executor: Executor = new ContentExecutor();
  let registry = new GroupRegistry(executor);
  let router = new CommandRouter(registry, executor);
  let executorKind: ExecutorKind = "content";

  // Rebuild the executor stack from current settings. Called at boot and after
  // the user changes settings (executor mode may have flipped).
  async function rebuild(): Promise<void> {
    const settings = await getSettings();
    // Detach the outgoing executor's debugger sessions before replacing it,
    // otherwise the "being debugged" banner sticks and a later switch back to
    // CDP starts with an empty (stale) attachment set.
    await executor.releaseAll().catch(() => {});
    executorKind = resolveExecutorKind(settings.executorMode, detectCapabilities());
    executor = executorKind === "cdp" ? new CdpExecutor() : new ContentExecutor();
    registry = new GroupRegistry(executor);
    router = new CommandRouter(registry, executor);
    // Recover groups tracked before an MV3 worker suspend / rebuild.
    await registry.hydrate();
  }

  const client = new BridgeClient({
    getConfig: async () => {
      const s = await getSettings();
      return { url: s.bridgeUrl, token: s.token };
    },
    onCommand: (frame) => router.handle(frame),
    executorKind: () => executorKind,
    // The plugin-side `executor` option (when set) wins over the dashboard
    // choice on each connect — rebuild the stack if it differs.
    onServerPreference: async (mode: ExecutorMode) => {
      const settings = await getSettings();
      if (settings.executorMode === mode) {
        return;
      }
      await saveSettings({ executorMode: mode });
      await rebuild();
      await setStatus({ executor: executorKind });
    },
    // Release control (detach the CDP debugger) when the link drops, so the
    // browser isn't left with the "being debugged" banner after the agent stops.
    onDisconnected: () => executor.releaseAll(),
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
