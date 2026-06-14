import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/db", () => ({ setStatus: vi.fn().mockResolvedValue(undefined) }));

import { BridgeClient, type BridgeClientDeps } from "../src/background/bridge-client";
import { setStatus } from "../src/shared/db";
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from "../src/shared/protocol";

type Handler = (e: { data?: string }) => void;

class FakeWS {
  static last: FakeWS | null = null;
  sent: string[] = [];
  closed = false;
  private readonly handlers: Record<string, Handler[]> = {};
  constructor(public url: string) {
    FakeWS.last = this;
  }
  addEventListener(type: string, fn: Handler): void {
    (this.handlers[type] ||= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    for (const fn of this.handlers[type] ?? []) {
      fn({ data });
    }
  }
  lastFrame(type: string) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const f = decodeFrame(this.sent[i]);
      if (f?.type === type) {
        return f;
      }
    }
    return null;
  }
}

function makeDeps(over: Partial<BridgeClientDeps> = {}): BridgeClientDeps {
  return {
    getConfig: vi.fn().mockResolvedValue({
      url: "ws://127.0.0.1:4517",
      token: "tok",
      id: "e1",
      label: "work",
      browser: "chrome"
    }),
    onCommand: vi.fn().mockResolvedValue({ ok: true }),
    onCancel: vi.fn(),
    executorKind: () => "cdp",
    clientName: "ext/chrome",
    ...over
  };
}

beforeEach(() => {
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  FakeWS.last = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

async function connected(deps = makeDeps()) {
  const client = new BridgeClient(deps);
  await client.connect();
  const ws = FakeWS.last as FakeWS;
  ws.emit("open");
  return { client, ws, deps };
}

describe("BridgeClient handshake", () => {
  it("sends a hello with role + identity once the socket opens", async () => {
    const { ws } = await connected();
    expect(ws.lastFrame("hello")).toMatchObject({
      type: "hello",
      token: "tok",
      role: "extension",
      id: "e1",
      label: "work",
      browser: "chrome"
    });
  });

  it("marks the status connected on ready", async () => {
    const { ws } = await connected();
    ws.emit(
      "message",
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "ready",
        server: "opencode-browser",
        protocol: PROTOCOL_VERSION
      })
    );
    await Promise.resolve();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "connected" }));
  });

  it("does not open a socket when no token is configured", async () => {
    const client = new BridgeClient(
      makeDeps({ getConfig: vi.fn().mockResolvedValue({ url: "ws://x", token: "" }) })
    );
    await client.connect();
    expect(FakeWS.last).toBeNull();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }));
  });
});

describe("BridgeClient frame routing", () => {
  it("runs a command and sends back the correlated result", async () => {
    const onCommand = vi.fn().mockResolvedValue({ url: "u" });
    const { ws } = await connected(makeDeps({ onCommand }));
    ws.emit(
      "message",
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "x1",
        action: "open",
        group: "g",
        params: {}
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "x1", action: "open" }));
    const result = ws.lastFrame("result");
    expect(result).toMatchObject({ id: "x1", ok: true, data: { url: "u" } });
  });

  it("sends an error result when the command handler throws", async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error("boom"));
    const { ws } = await connected(makeDeps({ onCommand }));
    ws.emit(
      "message",
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "x2",
        action: "click",
        group: "g",
        params: {}
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.lastFrame("result")).toMatchObject({ id: "x2", ok: false });
  });

  it("routes a cancel frame to onCancel", async () => {
    const onCancel = vi.fn();
    const { ws } = await connected(makeDeps({ onCancel }));
    ws.emit("message", encodeFrame({ v: PROTOCOL_VERSION, type: "cancel", id: "x3" }));
    await Promise.resolve();
    expect(onCancel).toHaveBeenCalledWith("x3");
  });

  it("answers ping with pong", async () => {
    const { ws } = await connected();
    ws.emit("message", encodeFrame({ v: PROTOCOL_VERSION, type: "ping" }));
    expect(ws.lastFrame("pong")).toMatchObject({ type: "pong" });
  });
});

describe("BridgeClient disconnect", () => {
  it("closes the socket and reports disconnected", async () => {
    const onDisconnected = vi.fn();
    const { client, ws } = await connected(makeDeps({ onDisconnected }));
    client.disconnect();
    expect(ws.closed).toBe(true);
    expect(onDisconnected).toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "disconnected" }));
  });
});
