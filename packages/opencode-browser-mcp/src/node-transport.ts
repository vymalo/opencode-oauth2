import type { BridgeTransport, ClientConnection } from "@vymalo/opencode-browser/lib";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * `BridgeTransport` backed by the Node `ws` package, so the MCP server can host
 * the bridge under plain Node (the way most MCP clients launch a server). The
 * plugin uses the Bun-backed transport instead; both satisfy the same seam.
 */
export function createNodeTransport(): BridgeTransport {
  let server: WebSocketServer | null = null;

  return {
    listen({ host, port }, handlers) {
      server = new WebSocketServer({ host, port });
      server.on("connection", (ws: WebSocket) => {
        const conn: ClientConnection = {
          send: (data) => ws.send(data),
          close: () => ws.close()
        };
        handlers.onOpen(conn);
        ws.on("message", (data) => handlers.onMessage(conn, data.toString()));
        ws.on("close", () => handlers.onClose(conn));
        ws.on("error", () => {
          /* the close event follows */
        });
      });
    },
    stop() {
      server?.close();
      server = null;
    }
  };
}
