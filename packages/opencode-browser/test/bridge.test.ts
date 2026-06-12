import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Bridge,
  type BridgeTransport,
  type ClientConnection,
  type TransportHandlers
} from "../src/bridge.js";
import type { Logger } from "../src/logging.js";
import { type CommandFrame, decodeFrame, encodeFrame, PROTOCOL_VERSION } from "../src/protocol.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Transport that records the handlers and lets a test drive socket lifecycle. */
class FakeTransport implements BridgeTransport {
  handlers: TransportHandlers | null = null;
  stopped = false;
  listen(_opts: { host: string; port: number }, handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
  stop(): void {
    this.stopped = true;
  }
}

function makeConn() {
  const sent: string[] = [];
  let closed = false;
  const conn: ClientConnection = {
    send: (data) => sent.push(data),
    close: () => {
      closed = true;
    }
  };
  return {
    conn,
    sent,
    isClosed: () => closed
  };
}

/** Pull the last command frame the bridge sent to a connection. */
function lastCommand(sent: string[]): CommandFrame {
  for (let i = sent.length - 1; i >= 0; i--) {
    const frame = decodeFrame(sent[i]);
    if (frame?.type === "command") {
      return frame;
    }
  }
  throw new Error("no command frame found");
}

function setup() {
  const transport = new FakeTransport();
  const bridge = new Bridge(
    { host: "127.0.0.1", port: 4517, token: "secret", timeoutMs: 1000 },
    { logger: noopLogger, transport }
  );
  bridge.start();
  return { transport, bridge };
}

function connect(transport: FakeTransport, token = "secret") {
  const client = makeConn();
  transport.handlers?.onMessage(
    client.conn,
    encodeFrame({ v: PROTOCOL_VERSION, type: "hello", token })
  );
  return client;
}

describe("Bridge handshake", () => {
  it("accepts a valid token and replies ready", () => {
    const { transport, bridge } = setup();
    const client = connect(transport);
    expect(bridge.connected).toBe(true);
    expect(decodeFrame(client.sent[0])).toMatchObject({
      type: "ready",
      server: "opencode-browser"
    });
  });

  it("rejects and closes a bad token", () => {
    const { transport, bridge } = setup();
    const client = connect(transport, "wrong");
    expect(bridge.connected).toBe(false);
    expect(client.isClosed()).toBe(true);
  });

  it("latest valid client wins and the old one is closed", () => {
    const { transport, bridge } = setup();
    const first = connect(transport);
    const second = connect(transport);
    expect(first.isClosed()).toBe(true);
    expect(bridge.connected).toBe(true);
    expect(second.isClosed()).toBe(false);
  });
});

describe("Bridge send", () => {
  it("rejects when no extension is connected", async () => {
    const { bridge } = setup();
    await expect(bridge.send("open", "g", {})).rejects.toThrow(/no browser extension is connected/);
  });

  it("correlates a result back to the pending command", async () => {
    const { transport, bridge } = setup();
    const client = connect(transport);
    const promise = bridge.send("open", "research", { url: "https://x" });
    const cmd = lastCommand(client.sent);
    expect(cmd).toMatchObject({ action: "open", group: "research", params: { url: "https://x" } });
    transport.handlers?.onMessage(
      client.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "result",
        id: cmd.id,
        ok: true,
        data: { title: "X" }
      })
    );
    await expect(promise).resolves.toEqual({ title: "X" });
  });

  it("rejects when the extension reports an error", async () => {
    const { transport, bridge } = setup();
    const client = connect(transport);
    const promise = bridge.send("click", "g", {});
    const cmd = lastCommand(client.sent);
    transport.handlers?.onMessage(
      client.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "result",
        id: cmd.id,
        ok: false,
        error: { message: "element not found", code: "no_element" }
      })
    );
    await expect(promise).rejects.toThrow(/element not found/);
  });

  it("rejects pending commands when the extension disconnects", async () => {
    const { transport, bridge } = setup();
    const client = connect(transport);
    const promise = bridge.send("screenshot", "g", {});
    transport.handlers?.onClose(client.conn);
    await expect(promise).rejects.toThrow(/disconnected/);
    expect(bridge.connected).toBe(false);
  });

  it("rejects immediately when given an already-aborted signal", async () => {
    const { transport, bridge } = setup();
    connect(transport);
    const ac = new AbortController();
    ac.abort();
    await expect(bridge.send("open", "g", {}, ac.signal)).rejects.toThrow(/aborted/);
  });

  it("rejects when the signal aborts mid-flight", async () => {
    const { transport, bridge } = setup();
    connect(transport);
    const ac = new AbortController();
    const promise = bridge.send("open", "g", {}, ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it("ignores result frames from an unauthenticated connection", async () => {
    const { transport, bridge } = setup();
    const client = connect(transport);
    const promise = bridge.send("open", "g", {});
    const cmd = lastCommand(client.sent);

    // A second local socket that never completed the handshake tries to resolve
    // the pending command using a guessed id — it must be ignored.
    const intruder = makeConn();
    transport.handlers?.onMessage(
      intruder.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "result",
        id: cmd.id,
        ok: true,
        data: { hacked: true }
      })
    );
    // The real client can still resolve it.
    transport.handlers?.onMessage(
      client.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "result",
        id: cmd.id,
        ok: true,
        data: { real: true }
      })
    );
    await expect(promise).resolves.toEqual({ real: true });
  });

  it("rejects in-flight commands when a new client takes over", async () => {
    const { transport, bridge } = setup();
    connect(transport);
    const promise = bridge.send("open", "g", {});
    connect(transport); // a fresh valid hello replaces the client
    await expect(promise).rejects.toThrow(/reconnected/);
  });
});

describe("Bridge timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("times out a command with no reply", async () => {
    const { transport, bridge } = setup();
    connect(transport);
    const promise = bridge.send("wait", "g", {});
    const expectation = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await expectation;
  });
});
