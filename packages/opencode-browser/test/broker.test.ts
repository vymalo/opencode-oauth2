import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Broker } from "../src/broker.js";
import type { Logger } from "../src/logging.js";
import {
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  helloFrame,
  PROTOCOL_VERSION
} from "../src/protocol.js";
import type { BridgeTransport, ClientConnection, TransportHandlers } from "../src/transport.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeTransport implements BridgeTransport {
  handlers: TransportHandlers | null = null;
  stopped = false;
  listen(_opts: { host: string; port: number }, handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    return Promise.resolve();
  }
  stop(): void {
    this.stopped = true;
  }
}

function makeConn() {
  const sent: string[] = [];
  let closed = false;
  const conn: ClientConnection = {
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
    }
  };
  return { conn, sent, isClosed: () => closed };
}

function lastCommand(sent: string[]): CommandFrame {
  for (let i = sent.length - 1; i >= 0; i--) {
    const frame = decodeFrame(sent[i]);
    if (frame?.type === "command") {
      return frame;
    }
  }
  throw new Error("no command frame found");
}

async function setup() {
  const transport = new FakeTransport();
  const broker = new Broker(
    { host: "127.0.0.1", port: 4517, token: "secret", timeoutMs: 1000 },
    { logger: noopLogger, transport }
  );
  await broker.start();
  const handlers = transport.handlers;
  if (!handlers) {
    throw new Error("transport did not register handlers");
  }
  const h = () => handlers;
  return { transport, broker, h };
}

function connectExecutor(
  h: () => TransportHandlers,
  opts: { id?: string; label?: string; browser?: string; token?: string } = {}
) {
  const client = makeConn();
  h().onMessage(
    client.conn,
    encodeFrame(
      helloFrame(opts.token ?? "secret", {
        role: "extension",
        id: opts.id,
        label: opts.label,
        browser: opts.browser
      })
    )
  );
  return client;
}

function connectAgent(h: () => TransportHandlers) {
  const client = makeConn();
  h().onMessage(client.conn, encodeFrame(helloFrame("secret", { role: "agent" })));
  return client;
}

/** Reply to the latest command the broker sent to an executor. */
function replyOk(h: () => TransportHandlers, exec: ReturnType<typeof makeConn>, data: unknown) {
  const cmd = lastCommand(exec.sent);
  h().onMessage(
    exec.conn,
    encodeFrame({ v: PROTOCOL_VERSION, type: "result", id: cmd.id, ok: true, data })
  );
  return cmd;
}

describe("Broker handshake", () => {
  it("accepts an executor and replies ready with its id", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1", label: "chrome", browser: "chrome" });
    expect(broker.executorCount).toBe(1);
    expect(decodeFrame(exec.sent[0])).toMatchObject({
      type: "ready",
      role: "extension",
      clientId: "e1"
    });
  });

  it("rejects a bad token", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { token: "wrong" });
    expect(broker.executorCount).toBe(0);
    expect(exec.isClosed()).toBe(true);
  });

  it("accepts an agent", async () => {
    const { h } = await setup();
    const agent = connectAgent(h);
    expect(decodeFrame(agent.sent[0])).toMatchObject({ type: "ready", role: "agent" });
  });
});

describe("Broker routing (local agent)", () => {
  it("routes a command to the only executor and correlates the result", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const promise = agent.send("open", "research", { url: "https://x" });
    const cmd = replyOk(h, exec, { url: "https://x", title: "X" });
    expect(cmd).toMatchObject({ action: "open", group: "research" });
    await expect(promise).resolves.toEqual({ url: "https://x", title: "X" });
  });

  it("routes later commands for a group to its owning executor", async () => {
    const { broker, h } = await setup();
    connectExecutor(h, { id: "ea", label: "a" });
    const b = connectExecutor(h, { id: "eb", label: "b" });
    const agent = broker.createLocalAgent();

    const open = agent.send("open", "g", {}, undefined, "b"); // target the 2nd browser
    replyOk(h, b, { url: "u" });
    await open;

    const click = agent.send("click", "g", { ref: "e1" });
    // the click must go to executor b, not a
    const cmd = lastCommand(b.sent);
    expect(cmd.action).toBe("click");
    replyOk(h, b, { ok: true });
    await click;
    // a only ever received its rebuild "tabs" probe, never the click
    expect(b.sent.filter((s) => decodeFrame(s)?.type === "command").length).toBeGreaterThanOrEqual(
      2
    );
  });

  it("errors on a command for an unknown group", async () => {
    const { broker, h } = await setup();
    connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    await expect(agent.send("click", "ghost", {})).rejects.toThrow(/no open tabs/);
  });

  it("errors when no executor is connected", async () => {
    const { broker } = await setup();
    const agent = broker.createLocalAgent();
    await expect(agent.send("open", "g", {})).rejects.toThrow(/no browser extension/);
  });

  it("answers browser_targets locally", async () => {
    const { broker, h } = await setup();
    connectExecutor(h, { id: "e1", label: "work", browser: "chrome" });
    const agent = broker.createLocalAgent();
    const data = (await agent.send("targets", "", {})) as {
      targets: Array<{ id: string; label: string }>;
    };
    expect(data.targets).toEqual([
      expect.objectContaining({ id: "e1", label: "work", browser: "chrome" })
    ]);
  });
});

describe("Broker ownership (multiple agents)", () => {
  it("forbids a second agent from driving another agent's group", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const localA = broker.createLocalAgent();
    const open = localA.send("open", "g", {});
    replyOk(h, exec, { url: "u" });
    await open;

    const agentB = connectAgent(h);
    h().onMessage(
      agentB.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "b1",
        action: "click",
        group: "g",
        params: {}
      })
    );
    await new Promise((r) => setTimeout(r, 0)); // let the async command handler reply
    const reply = agentB.sent
      .map((s) => decodeFrame(s))
      .find((f) => f?.type === "result" && f.id === "b1");
    expect(reply).toMatchObject({ ok: false });
    expect((reply as { error?: { message: string } }).error?.message).toMatch(
      /owned by another client/
    );
  });

  it("orphaned groups are adoptable after the owner disconnects", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agentA = connectAgent(h);
    h().onMessage(
      agentA.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "a1",
        action: "open",
        group: "g",
        params: {}
      })
    );
    replyOk(h, exec, { url: "u" });

    h().onClose(agentA.conn); // owner leaves → group orphaned

    const localB = broker.createLocalAgent();
    const click = localB.send("click", "g", {}); // adopts the orphan
    replyOk(h, exec, { ok: true });
    await expect(click).resolves.toEqual({ ok: true });
  });
});

describe("Broker release", () => {
  const sawRelease = (sent: string[]): boolean =>
    sent.map((s) => decodeFrame(s)).some((f) => f?.type === "release");

  it("releases the owned executor when its agent disconnects", async () => {
    const { h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agentA = connectAgent(h);
    h().onMessage(
      agentA.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "a1",
        action: "open",
        group: "g",
        params: {}
      })
    );
    replyOk(h, exec, { url: "u" });
    await new Promise((r) => setTimeout(r, 0));

    h().onClose(agentA.conn); // owner leaves
    expect(sawRelease(exec.sent)).toBe(true);
  });

  it("does not broadcast release to executors an agent never owned", async () => {
    const { h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agentB = connectAgent(h); // owns no groups
    h().onMessage(
      agentB.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "b1",
        action: "release",
        group: "",
        params: {}
      })
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sawRelease(exec.sent)).toBe(false);
  });
});

describe("Broker failure modes", () => {
  it("rejects pending commands when the executor disconnects", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const open = agent.send("open", "g", {});
    h().onClose(exec.conn);
    await expect(open).rejects.toThrow(/disconnected/);
  });

  it("rejects on abort", async () => {
    const { broker, h } = await setup();
    connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const ac = new AbortController();
    const open = agent.send("open", "g", {}, ac.signal);
    ac.abort();
    await expect(open).rejects.toThrow(/aborted/);
  });
});

describe("Broker timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("times out a command with no reply", async () => {
    const { broker, h } = await setup();
    connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const open = agent.send("open", "g", {});
    const expectation = expect(open).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await expectation;
  });
});

/** Does `sent` contain a `cancel` frame for command `id`? */
function hasCancel(sent: string[], id: string): boolean {
  return sent.some((s) => {
    const f = decodeFrame(s);
    return f?.type === "cancel" && f.id === id;
  });
}

describe("Broker cancellation (Phase 0)", () => {
  it("sends a cancel frame to the executor when a command is aborted", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const ac = new AbortController();
    const open = agent.send("open", "g", {}, ac.signal);
    const cmd = lastCommand(exec.sent);
    ac.abort();
    await expect(open).rejects.toThrow(/aborted/);
    expect(hasCancel(exec.sent, cmd.id)).toBe(true);
  });

  it("cancels in-flight commands on the executor when the agent disconnects", async () => {
    const { h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agent = connectAgent(h);
    // Remote agent issues an open; the broker forwards it to the executor.
    h().onMessage(
      agent.conn,
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "a1",
        action: "open",
        group: "g",
        params: {}
      })
    );
    const cmd = lastCommand(exec.sent);
    h().onClose(agent.conn);
    expect(hasCancel(exec.sent, cmd.id)).toBe(true);
  });

  it("does not emit a cancel when a command completes normally", async () => {
    const { broker, h } = await setup();
    const exec = connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const open = agent.send("open", "g", {});
    const cmd = replyOk(h, exec, { url: "u" });
    await open;
    expect(hasCancel(exec.sent, cmd.id)).toBe(false);
  });
});

describe("Broker per-command timeout (Phase 0)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("honors a per-command override longer than the global timeout", async () => {
    const { broker, h } = await setup(); // global timeoutMs: 1000
    connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    let settled = false;
    const open = agent.send("open", "g", {}, undefined, undefined, 5000).catch(() => {
      settled = true;
    });
    // Past the global deadline but inside the override — still pending.
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(false);
    // Past the override — now it times out.
    await vi.advanceTimersByTimeAsync(4000);
    await open;
    expect(settled).toBe(true);
  });

  it("clamps a per-command override to maxCommandMs", async () => {
    const transport = new FakeTransport();
    const broker = new Broker(
      { host: "127.0.0.1", port: 4517, token: "secret", timeoutMs: 1000, maxCommandMs: 2000 },
      { logger: noopLogger, transport }
    );
    await broker.start();
    const h = () => {
      if (!transport.handlers) {
        throw new Error("no handlers");
      }
      return transport.handlers;
    };
    const exec = connectExecutor(h, { id: "e1" });
    const agent = broker.createLocalAgent();
    const open = agent.send("open", "g", {}, undefined, undefined, 999_999);
    const cmd = lastCommand(exec.sent);
    const expectation = expect(open).rejects.toThrow(/timed out after 2000ms/);
    await vi.advanceTimersByTimeAsync(2001);
    await expectation;
    expect(hasCancel(exec.sent, cmd.id)).toBe(true);
  });
});
