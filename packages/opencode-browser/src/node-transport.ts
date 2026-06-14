import { WebSocket, WebSocketServer } from "ws";

import type { AgentSocket, AgentSocketHandlers } from "./agent-client.js";
import type { BridgeTransport, ClientConnection } from "./transport.js";

/**
 * `BridgeTransport` backed by the Node `ws` package. This is the bridge's single
 * host transport: `ws` runs under both Node *and* Bun, so it covers every
 * runtime OpenCode loads the plugin in — the Bun CLI/web *and* the Node desktop
 * app — without a Bun-specific code path. `listen` resolves once bound and
 * rejects on `EADDRINUSE`, which drives the endpoint's host-vs-guest election.
 */
export function createNodeTransport(): BridgeTransport {
  let server: WebSocketServer | null = null;

  return {
    listen({ host, port }, handlers) {
      return new Promise<void>((resolve, reject) => {
        const wss = new WebSocketServer({ host, port });
        server = wss;
        wss.once("listening", () => resolve());
        wss.once("error", (err) => reject(err));
        wss.on("connection", (ws: WebSocket) => {
          const conn: ClientConnection = {
            send: (data) => ws.send(data),
            close: () => ws.close()
          };
          handlers.onOpen(conn);
          ws.on("message", (data) => handlers.onMessage(conn, data.toString()));
          ws.on("close", () => handlers.onClose(conn));
          ws.on("error", () => {
            /* close follows */
          });
        });
      });
    },
    stop() {
      server?.close();
      server = null;
    }
  };
}

/** Agent-socket factory backed by the Node `ws` client (guest mode). */
export function createNodeAgentSocket(url: string, handlers: AgentSocketHandlers): AgentSocket {
  const ws = new WebSocket(url);
  ws.on("open", () => handlers.onOpen());
  ws.on("message", (data) => handlers.onMessage(data.toString()));
  ws.on("close", () => handlers.onClose());
  ws.on("error", () => {
    /* close follows */
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close()
  };
}
