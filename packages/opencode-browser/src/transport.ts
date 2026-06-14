/**
 * The transport seam for the bridge/broker. The real implementation is the Node
 * `ws` variant in `node-transport.ts` (which runs under both Node and Bun);
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
