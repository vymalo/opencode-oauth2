import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentClient,
  type AgentSocketFactory,
  type AgentSocketHandlers
} from "../src/agent-client.js";
import type { Logger } from "../src/logging.js";
import { type CommandFrame, decodeFrame, encodeFrame, PROTOCOL_VERSION } from "../src/protocol.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeSocket() {
  const sent: string[] = [];
  let handlers: AgentSocketHandlers | null = null;
  const factory: AgentSocketFactory = (_url, h) => {
    handlers = h;
    return { send: (d) => sent.push(d), close: () => {} };
  };
  return {
    sent,
    factory,
    handlers: () => {
      if (!handlers) {
        throw new Error("socket not created");
      }
      return handlers;
    }
  };
}

function lastCommand(sent: string[]): CommandFrame {
  for (let i = sent.length - 1; i >= 0; i--) {
    const f = decodeFrame(sent[i]);
    if (f?.type === "command") {
      return f;
    }
  }
  throw new Error("no command frame");
}

/** Build a connected AgentClient over a fake socket. */
async function connected() {
  const fs = fakeSocket();
  const client = new AgentClient(
    { url: "ws://x", token: "t", timeoutMs: 1000 },
    { logger: noopLogger, createSocket: fs.factory }
  );
  const p = client.connect();
  fs.handlers().onOpen();
  fs.handlers().onMessage(
    encodeFrame({
      v: PROTOCOL_VERSION,
      type: "ready",
      server: "opencode-browser",
      protocol: PROTOCOL_VERSION,
      role: "agent",
      clientId: "a1"
    })
  );
  await p;
  return { client, fs };
}

describe("AgentClient per-command timeout (Phase 0)", () => {
  it("forwards a per-command timeoutMs on the command frame for the broker to honor", async () => {
    const { client, fs } = await connected();
    void client.send("snapshot", "g", {}, undefined, undefined, 120_000).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastCommand(fs.sent)).toMatchObject({ action: "snapshot", timeoutMs: 120_000 });
  });

  it("leaves timeoutMs undefined when no override is given", async () => {
    const { client, fs } = await connected();
    void client.send("snapshot", "g", {}).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastCommand(fs.sent).timeoutMs).toBeUndefined();
  });
});

describe("AgentClient local backstop timer (Phase 0)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires the local backstop only after the requested deadline plus grace", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    const cp = client.connect();
    fs.handlers().onOpen();
    fs.handlers().onMessage(
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "ready",
        server: "opencode-browser",
        protocol: PROTOCOL_VERSION,
        role: "agent",
        clientId: "a1"
      })
    );
    await cp;

    let settled = false;
    void client.send("snapshot", "g", {}, undefined, undefined, 5000).catch(() => {
      settled = true;
    });
    // Past the requested 5s but before requested + 5s grace (10s) — broker
    // should win, so the local backstop must still be pending.
    await vi.advanceTimersByTimeAsync(9000);
    expect(settled).toBe(false);
    // Past requested + grace — the backstop fires.
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
  });
});
