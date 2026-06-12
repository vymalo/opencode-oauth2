import { setStatus } from "../shared/db";
import {
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  errorFrame,
  helloFrame,
  PROTOCOL_VERSION,
  resultFrame
} from "../shared/protocol";
import type { ExecutorKind } from "../shared/types";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 25_000;

export interface BridgeClientConfig {
  url: string;
  token: string;
}

export interface BridgeClientDeps {
  /** Latest connection config (re-read on every (re)connect). */
  getConfig: () => Promise<BridgeClientConfig>;
  /** Execute one command and resolve with its result data. */
  onCommand: (frame: CommandFrame) => Promise<unknown>;
  /** Executor kind to publish in the status row, for the UI. */
  executorKind: () => ExecutorKind;
  /** Descriptor sent in the hello frame (e.g. "chrome/Linux"). */
  clientName: string;
}

/**
 * Outbound WebSocket to the plugin's bridge. The extension is always the
 * dialer (extensions can't host servers). Reconnects with exponential backoff
 * and runs a lightweight ping heartbeat.
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(private readonly deps: BridgeClientDeps) {}

  async connect(): Promise<void> {
    this.stopped = false;
    this.clearReconnect();
    await this.openSocket();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    void setStatus({ state: "disconnected", connectedAt: undefined });
  }

  /** Force a fresh socket (e.g. after settings change). */
  async reconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    await this.connect();
  }

  private async openSocket(): Promise<void> {
    let config: BridgeClientConfig;
    try {
      config = await this.deps.getConfig();
    } catch (err) {
      await this.fail(`config error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!config.token) {
      await setStatus({
        state: "error",
        lastError: "no token set — open the dashboard and paste the bridge token"
      });
      return;
    }

    await setStatus({ state: "connecting", lastError: undefined });
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.url);
    } catch (err) {
      await this.fail(`bad bridge URL: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      ws.send(encodeFrame(helloFrame(config.token, this.deps.clientName)));
    });
    ws.addEventListener("message", (event) => this.onMessage(ws, String(event.data)));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => {
      // The close event always follows; let it handle reconnect.
    });
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    const frame = decodeFrame(raw);
    if (!frame) {
      return;
    }
    switch (frame.type) {
      case "ready":
        this.backoff = INITIAL_BACKOFF_MS;
        this.startHeartbeat();
        await setStatus({
          state: "connected",
          connectedAt: Date.now(),
          lastError: undefined,
          executor: this.deps.executorKind()
        });
        return;
      case "command":
        await this.runCommand(ws, frame);
        return;
      case "ping":
        ws.send(encodeFrame({ v: PROTOCOL_VERSION, type: "pong" }));
        return;
      default:
        return;
    }
  }

  private async runCommand(ws: WebSocket, frame: CommandFrame): Promise<void> {
    try {
      const data = await this.deps.onCommand(frame);
      ws.send(encodeFrame(resultFrame(frame.id, data)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(encodeFrame(errorFrame(frame.id, message)));
    }
  }

  private onClose(): void {
    this.stopHeartbeat();
    if (this.stopped) {
      return;
    }
    void setStatus({ state: "connecting", connectedAt: undefined });
    this.scheduleReconnect();
  }

  private async fail(message: string): Promise<void> {
    await setStatus({ state: "error", lastError: message });
    if (!this.stopped) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => void this.openSocket(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encodeFrame({ v: PROTOCOL_VERSION, type: "ping" }));
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
