/**
 * The transport seam for the bridge/broker. The real implementation wraps
 * `Bun.serve`'s WebSocket support; the MCP server provides a Node `ws` variant;
 * tests inject a fake. `listen` is **async** and resolves only once the port is
 * actually bound (and rejects on `EADDRINUSE`) — that's what the broker election
 * relies on to decide host-vs-guest.
 */

/** A single connected client (an extension executor or an agent). */
export interface ClientConnection {
  send(data: string): void;
  close(): void;
}

export interface TransportHandlers {
  onOpen(conn: ClientConnection): void;
  onMessage(conn: ClientConnection, data: string): void;
  onClose(conn: ClientConnection): void;
}

export interface BridgeTransport {
  /** Bind + start listening. Resolves when bound; rejects on bind failure. */
  listen(opts: { host: string; port: number }, handlers: TransportHandlers): Promise<void>;
  stop(): void;
}

/** True for an "address already in use" style bind error (→ become a guest). */
export function isAddrInUse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /eaddrinuse|address already in use|in use/i.test(msg);
}

interface BunWebSocket {
  send(data: string | ArrayBufferLike): void;
  close(): void;
}
interface BunLike {
  serve(options: Record<string, unknown>): { stop(closeActive?: boolean): void };
}

/**
 * Real transport backed by `Bun.serve` — the production path inside OpenCode
 * (which runs on Bun). Throws if invoked outside Bun.
 */
export function createBunTransport(): BridgeTransport {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (!bun) {
    throw new Error("the opencode-browser bridge requires the Bun runtime (Bun.serve not found)");
  }
  let server: { stop(closeActive?: boolean): void } | null = null;
  const conns = new WeakMap<object, ClientConnection>();

  return {
    listen({ host, port }, handlers) {
      return new Promise<void>((resolve, reject) => {
        try {
          server = bun.serve({
            hostname: host,
            port,
            fetch(req: Request, srv: { upgrade(req: Request): boolean }) {
              if (srv.upgrade(req)) {
                return undefined;
              }
              return new Response("opencode-browser bridge: websocket only", { status: 426 });
            },
            websocket: {
              open(ws: BunWebSocket) {
                const conn: ClientConnection = { send: (d) => ws.send(d), close: () => ws.close() };
                conns.set(ws, conn);
                handlers.onOpen(conn);
              },
              message(ws: BunWebSocket, message: string | ArrayBufferLike) {
                const conn = conns.get(ws);
                if (conn) {
                  handlers.onMessage(
                    conn,
                    typeof message === "string" ? message : Buffer.from(message).toString()
                  );
                }
              },
              close(ws: BunWebSocket) {
                const conn = conns.get(ws);
                conns.delete(ws);
                if (conn) {
                  handlers.onClose(conn);
                }
              }
            }
          });
          resolve(); // Bun.serve throws synchronously on EADDRINUSE; reaching here = bound.
        } catch (err) {
          reject(err);
        }
      });
    },
    stop() {
      server?.stop(true);
      server = null;
    }
  };
}
