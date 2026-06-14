import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeAgentSocket, createNodeTransport } from "../src/node-transport.js";
import { type BridgeTransport, isAddrInUse } from "../src/transport.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe("createNodeTransport (ws)", () => {
  const transports: BridgeTransport[] = [];
  afterEach(() => {
    for (const t of transports.splice(0)) {
      t.stop();
    }
  });

  it("binds, accepts a client, and round-trips a message", async () => {
    const port = await freePort();
    const host = "127.0.0.1";
    const server = createNodeTransport();
    transports.push(server);

    // Echo "ping" -> "pong" from the server side.
    await server.listen(
      { host, port },
      {
        onOpen() {},
        onMessage(conn, data) {
          if (data === "ping") {
            conn.send("pong");
          }
        },
        onClose() {}
      }
    );

    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 2000);
      const sock = createNodeAgentSocket(`ws://${host}:${port}`, {
        onOpen: () => sock.send("ping"),
        onMessage: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        onClose: () => {}
      });
    });

    expect(reply).toBe("pong");
  });

  it("rejects with an addr-in-use error when the port is taken", async () => {
    const port = await freePort();
    const host = "127.0.0.1";
    const first = createNodeTransport();
    const second = createNodeTransport();
    transports.push(first, second);

    const noop = { onOpen() {}, onMessage() {}, onClose() {} };
    await first.listen({ host, port }, noop);

    const err = await second.listen({ host, port }, noop).then(
      () => null,
      (e) => e
    );
    expect(err).not.toBeNull();
    expect(isAddrInUse(err)).toBe(true);
  });
});
