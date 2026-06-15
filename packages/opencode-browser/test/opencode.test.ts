import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import type { AgentSocketFactory } from "../src/agent-client.js";
import type { BridgeTransport, TransportHandlers } from "../src/transport.js";

// Isolate the shared-token state file so the factory never touches the real
// ~/Library/Application Support (…) bridge.json that a live OpenCode shares.
vi.mock("../src/token-file.js", () => ({
  resolveSharedToken: (_port: number, explicit: string | undefined, generate: () => string) =>
    explicit ? { token: explicit, source: "explicit" } : { token: generate(), source: "generated" },
  writeBridgeFile: vi.fn(),
  // No shared file yet, so the host writes + advertises its own token.
  readBridgeFile: vi.fn(() => null)
}));

import { createBrowserPlugin } from "../src/opencode.js";

/** A transport that "binds" instantly (no real socket) → host election wins. */
class FakeTransport implements BridgeTransport {
  listen(_opts: { host: string; port: number }, _handlers: TransportHandlers): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {}
}
const fakeAgentSocket: AgentSocketFactory = () => ({ send() {}, close() {} });

function fakeClient() {
  const log = vi.fn().mockResolvedValue(undefined);
  return { client: { app: { log } } as unknown as PluginInput["client"], log };
}

async function load(pluginOptions: PluginOptions | undefined, client = fakeClient()) {
  const plugin = createBrowserPlugin({
    createServerTransport: () => new FakeTransport(),
    createAgentSocket: fakeAgentSocket,
    generateToken: () => "generated-token"
  });
  const hooks = await plugin({ client: client.client } as PluginInput, pluginOptions);
  return { hooks, client };
}

describe("createBrowserPlugin", () => {
  it("registers the default groups' tools and a config hook", async () => {
    const { hooks } = await load(undefined);
    const names = Object.keys(hooks.tool ?? {});
    expect(names).toContain("browser_open"); // control
    expect(names).toContain("browser_snapshot"); // page
    expect(names).not.toContain("browser_eval"); // debug opt-in
    expect(names).not.toContain("browser_request_feedback"); // interactive opt-in
    expect(typeof hooks.config).toBe("function");
  });

  it("registers debug + interactive tools when those groups are enabled", async () => {
    const { hooks } = await load({ groups: ["page", "control", "debug", "interactive"] });
    const names = Object.keys(hooks.tool ?? {});
    expect(names).toContain("browser_eval");
    expect(names).toContain("browser_request_feedback");
  });

  it("falls back to defaults for an invalid groups option", async () => {
    const { hooks } = await load({ groups: ["bogus", 123] as unknown as string[] });
    const names = Object.keys(hooks.tool ?? {});
    expect(names).toContain("browser_open");
    expect(names).not.toContain("browser_eval");
  });

  it("registers no tools when disabled", async () => {
    const { hooks } = await load({ enabled: false });
    expect(hooks.tool).toBeUndefined();
    expect(typeof hooks.config).toBe("function");
    await expect(hooks.config?.({ logLevel: "DEBUG" } as never)).resolves.toBeUndefined();
  });

  it("advertises a generated token through the host logger, but not an explicit one", async () => {
    const generated = await load(undefined);
    const logged = generated.client.log.mock.calls.map((c) => c[0]?.body?.message);
    expect(logged).toContain("browser_bridge_token");

    const explicit = await load({ token: "my-secret" });
    const logged2 = explicit.client.log.mock.calls.map((c) => c[0]?.body?.message);
    expect(logged2).not.toContain("browser_bridge_token");
  });

  it("config hook resolves and accepts a log level", async () => {
    const { hooks } = await load(undefined);
    await expect(hooks.config?.({ logLevel: "WARN" } as never)).resolves.toBeUndefined();
  });
});
