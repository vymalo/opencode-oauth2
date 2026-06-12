import type { Logger } from "./logging.js";
import {
  type BrowserAction,
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  type EventFrame,
  type Frame,
  nextId,
  PROTOCOL_VERSION
} from "./protocol.js";

/**
 * A single connected client (the extension's background worker). The bridge
 * never holds more than one authenticated client at a time — the latest valid
 * `hello` wins.
 */
export interface ClientConnection {
  send(data: string): void;
  close(): void;
}

export interface TransportHandlers {
  onOpen(conn: ClientConnection): void;
  onMessage(conn: ClientConnection, data: string): void;
  onClose(conn: ClientConnection): void;
}

/**
 * The transport seam. The real implementation wraps `Bun.serve`'s WebSocket
 * support; tests inject a fake that drives the handlers directly. This is the
 * same dependency-injection shape the ratelimit plugin uses for its fetch.
 */
export interface BridgeTransport {
  listen(opts: { host: string; port: number }, handlers: TransportHandlers): void;
  stop(): void;
}

export interface BridgeOptions {
  host: string;
  port: number;
  token: string;
  /** Per-command timeout in ms; `<= 0` disables the timeout. */
  timeoutMs: number;
}

export interface BridgeDeps {
  logger: Logger;
  transport: BridgeTransport;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
}

/** Thrown when a command can't be delivered or the extension reports failure. */
export class BridgeError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

/**
 * Hosts the local WebSocket server and brokers request/response between the
 * plugin's tools and the connected extension. Runtime-agnostic: all I/O goes
 * through the injected `BridgeTransport`.
 */
export class Bridge {
  private readonly opts: BridgeOptions;
  private readonly logger: Logger;
  private readonly transport: BridgeTransport;
  private client: ClientConnection | null = null;
  private readonly pending = new Map<string, Pending>();
  private started = false;

  /** Optional sink for unsolicited extension events (tab/group changes). */
  onEvent: ((frame: EventFrame) => void) | null = null;

  constructor(opts: BridgeOptions, deps: BridgeDeps) {
    this.opts = opts;
    this.logger = deps.logger;
    this.transport = deps.transport;
  }

  /** True once an extension has completed the token handshake. */
  get connected(): boolean {
    return this.client !== null;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.transport.listen(
      { host: this.opts.host, port: this.opts.port },
      {
        onOpen: () => {
          /* Wait for `hello` before treating the socket as a real client. */
        },
        onMessage: (conn, data) => this.handleMessage(conn, data),
        onClose: (conn) => this.handleClose(conn)
      }
    );
    this.logger.info("browser_bridge_listening", { host: this.opts.host, port: this.opts.port });
  }

  stop(): void {
    this.rejectAllPending(new BridgeError("bridge stopped"));
    this.client = null;
    this.started = false;
    this.transport.stop();
  }

  /**
   * Send a command to the extension and resolve with its result `data`. Rejects
   * if no extension is connected, on timeout, on abort, or when the extension
   * reports an error.
   */
  send(
    action: BrowserAction,
    group: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.client) {
      return Promise.reject(
        new BridgeError(
          "no browser extension is connected to the opencode-browser bridge — open the extension and confirm it shows 'connected'",
          "not_connected"
        )
      );
    }
    if (signal?.aborted) {
      return Promise.reject(new BridgeError("aborted", "aborted"));
    }

    const id = nextId();
    const frame: CommandFrame = { v: PROTOCOL_VERSION, type: "command", id, action, group, params };

    return new Promise<unknown>((resolve, reject) => {
      const settleReject = (err: Error) => {
        this.clearPending(id);
        reject(err);
      };

      const timer =
        this.opts.timeoutMs > 0
          ? setTimeout(() => {
              this.logger.warn("browser_command_failed", { id, action, group, reason: "timeout" });
              settleReject(
                new BridgeError(
                  `command '${action}' timed out after ${this.opts.timeoutMs}ms`,
                  "timeout"
                )
              );
            }, this.opts.timeoutMs)
          : null;

      let detachAbort: (() => void) | null = null;
      if (signal) {
        const onAbort = () => settleReject(new BridgeError("aborted", "aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, { resolve, reject, timer, detachAbort });

      try {
        this.client?.send(encodeFrame(frame));
        this.logger.debug("browser_command_sent", { id, action, group });
      } catch (err) {
        settleReject(
          new BridgeError(
            `failed to deliver command '${action}': ${err instanceof Error ? err.message : String(err)}`,
            "send_failed"
          )
        );
      }
    });
  }

  private handleMessage(conn: ClientConnection, data: string): void {
    const frame = decodeFrame(data);
    if (!frame) {
      this.logger.warn("browser_frame_invalid", {});
      return;
    }
    switch (frame.type) {
      case "hello":
        this.handleHello(conn, frame.token, frame.client);
        return;
      case "result":
        this.handleResult(frame);
        return;
      case "event":
        this.logger.debug("browser_event", { name: frame.name, group: frame.group });
        this.onEvent?.(frame);
        return;
      case "ping":
        this.safeSend(conn, { v: PROTOCOL_VERSION, type: "pong" });
        return;
      case "pong":
        return;
      default:
        // `ready`/`command` are server-emitted; ignore if echoed back.
        return;
    }
  }

  private handleHello(conn: ClientConnection, token: string, client?: string): void {
    if (token !== this.opts.token) {
      this.logger.warn("browser_handshake_rejected", { reason: "bad_token" });
      conn.close();
      return;
    }
    // Latest valid client wins; drop any prior one.
    if (this.client && this.client !== conn) {
      this.client.close();
    }
    this.client = conn;
    this.logger.info("browser_ext_connected", { client: client ?? "unknown" });
    this.safeSend(conn, {
      v: PROTOCOL_VERSION,
      type: "ready",
      server: "opencode-browser",
      protocol: PROTOCOL_VERSION
    });
  }

  private handleResult(frame: Frame & { type: "result" }): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.clearPending(frame.id);
    if (frame.ok) {
      this.logger.debug("browser_command_ok", { id: frame.id });
      pending.resolve(frame.data);
    } else {
      const message = frame.error?.message ?? "extension reported an error";
      this.logger.warn("browser_command_failed", { id: frame.id, reason: message });
      pending.reject(new BridgeError(message, frame.error?.code));
    }
  }

  private handleClose(conn: ClientConnection): void {
    if (conn !== this.client) {
      return;
    }
    this.client = null;
    this.logger.info("browser_ext_disconnected", {});
    this.rejectAllPending(new BridgeError("browser extension disconnected", "disconnected"));
  }

  private safeSend(conn: ClientConnection, frame: Frame): void {
    try {
      conn.send(encodeFrame(frame));
    } catch {
      /* connection went away mid-send; close handler will clean up */
    }
  }

  private clearPending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.detachAbort?.();
    this.pending.delete(id);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.detachAbort?.();
      this.pending.delete(id);
      pending.reject(err);
    }
  }
}

/**
 * Real transport backed by `Bun.serve`. OpenCode runs on Bun, so this is the
 * production path. Throws if invoked outside Bun (tests use a fake transport).
 */
export function createBunTransport(): BridgeTransport {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (!bun) {
    throw new BridgeError(
      "the opencode-browser bridge requires the Bun runtime (Bun.serve was not found)"
    );
  }
  let server: { stop(closeActive?: boolean): void } | null = null;
  const conns = new WeakMap<object, ClientConnection>();

  return {
    listen({ host, port }, handlers) {
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
            const conn: ClientConnection = {
              send: (data) => ws.send(data),
              close: () => ws.close()
            };
            conns.set(ws, conn);
            handlers.onOpen(conn);
          },
          message(ws: BunWebSocket, message: string | ArrayBufferLike) {
            const conn = conns.get(ws);
            if (!conn) {
              return;
            }
            handlers.onMessage(
              conn,
              typeof message === "string" ? message : Buffer.from(message).toString()
            );
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
    },
    stop() {
      server?.stop(true);
      server = null;
    }
  };
}

// Minimal structural typings for the Bun globals we touch — avoids a hard
// dependency on @types/bun while keeping the call sites type-checked.
interface BunWebSocket {
  send(data: string | ArrayBufferLike): void;
  close(): void;
}
interface BunLike {
  serve(options: Record<string, unknown>): { stop(closeActive?: boolean): void };
}
