import type { Logger } from "./logging.js";
import {
  type BrowserAction,
  cancelFrame,
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  errorFrame,
  type EventFrame,
  type Frame,
  nextId,
  PROTOCOL_VERSION,
  resultFrame
} from "./protocol.js";
import type { BridgeTransport, ClientConnection } from "./transport.js";

/** Thrown when a command can't be routed or the executor reports failure. */
export class BrokerError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

/**
 * Hard ceiling for any per-command timeout, so a tool requesting a long
 * human-paced deadline can't pin a command open indefinitely. 10 minutes.
 */
export const DEFAULT_MAX_COMMAND_MS = 600_000;

/** What an agent (local or remote) uses to drive browsers through the broker. */
export interface AgentEndpoint {
  send(
    action: BrowserAction,
    group: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    target?: string,
    /** Per-command timeout override (ms), clamped to the broker's `maxCommandMs`. */
    timeoutMs?: number
  ): Promise<unknown>;
  /** Release this agent's browsers (detach the debugger) without closing tabs. */
  release(): void;
}

export interface BrokerOptions {
  host: string;
  port: number;
  token: string;
  /** Executor preference forwarded to extensions in `ready`. */
  executor?: "auto" | "cdp" | "content";
  /** Default per-command timeout in ms; `<= 0` disables. */
  timeoutMs: number;
  /** Ceiling a per-command override can request (default `DEFAULT_MAX_COMMAND_MS`). */
  maxCommandMs?: number;
}

export interface BrokerDeps {
  logger: Logger;
  transport: BridgeTransport;
}

interface ExecutorInfo {
  conn: ClientConnection;
  id: string;
  label: string;
  browser: string;
}

interface AgentInfo {
  conn: ClientConnection;
  id: string;
}

/** `agentId === null` ⇒ orphaned group (owner gone), adoptable by the next user. */
interface GroupOwner {
  executorId: string;
  agentId: string | null;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
  agentId: string;
  executorId: string;
}

/** Actions that aren't group-scoped — routed to the primary/target executor. */
const GLOBAL_ACTIONS = new Set<BrowserAction>(["cookies"]);

/**
 * Hosts the WebSocket server and routes commands between **agents** (producers:
 * the plugin, the MCP server, guest adapters) and **executors** (the browser
 * extensions), keyed by named-group ownership. Generalizes the old single-client
 * bridge. Runtime-agnostic via the injected transport.
 */
export class Broker {
  private readonly executors = new Map<ClientConnection, ExecutorInfo>();
  private readonly executorById = new Map<string, ExecutorInfo>();
  private readonly agents = new Map<ClientConnection, AgentInfo>();
  private readonly groupOwner = new Map<string, GroupOwner>();
  private readonly pending = new Map<string, Pending>();
  private primaryExecutorId: string | null = null;
  private agentSeq = 0;
  private execSeq = 0;
  private started = false;

  constructor(
    private readonly opts: BrokerOptions,
    private readonly deps: BrokerDeps
  ) {}

  get executorCount(): number {
    return this.executorById.size;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.deps.transport.listen(
      { host: this.opts.host, port: this.opts.port },
      {
        onOpen: () => {},
        onMessage: (conn, data) => this.onMessage(conn, data),
        onClose: (conn) => this.onClose(conn)
      }
    );
    this.started = true;
    this.deps.logger.info("browser_broker_listening", {
      host: this.opts.host,
      port: this.opts.port
    });
  }

  stop(): void {
    this.rejectAllPending(new BrokerError("broker stopped"));
    this.executors.clear();
    this.executorById.clear();
    this.agents.clear();
    this.groupOwner.clear();
    this.primaryExecutorId = null;
    this.started = false;
    this.deps.transport.stop();
  }

  /** An in-process agent (the host adapter's own tools), bypassing a socket. */
  createLocalAgent(): AgentEndpoint {
    const id = `local:${++this.agentSeq}`;
    return {
      send: (action, group, params, signal, target, timeoutMs) =>
        this.route(id, { action, group, params, target, timeoutMs }, signal),
      release: () => this.releaseForAgent(id)
    };
  }

  // ─── connection handling ───────────────────────────────────────────────────
  private onMessage(conn: ClientConnection, raw: string): void {
    const frame = decodeFrame(raw);
    if (!frame) {
      return;
    }
    if (frame.type === "hello") {
      this.handleHello(conn, frame);
      return;
    }
    const executor = this.executors.get(conn);
    if (executor) {
      if (frame.type === "result") {
        this.handleResult(frame);
      } else if (frame.type === "event") {
        this.routeEvent(frame);
      } else if (frame.type === "ping") {
        this.safeSend(conn, { v: PROTOCOL_VERSION, type: "pong" });
      }
      return;
    }
    const agent = this.agents.get(conn);
    if (agent) {
      if (frame.type === "command") {
        void this.handleAgentCommand(agent, conn, frame);
      } else if (frame.type === "ping") {
        this.safeSend(conn, { v: PROTOCOL_VERSION, type: "pong" });
      }
      return;
    }
    this.deps.logger.warn("browser_frame_unauthenticated", { type: frame.type });
  }

  private handleHello(conn: ClientConnection, frame: Frame & { type: "hello" }): void {
    if (frame.token !== this.opts.token) {
      this.deps.logger.warn("browser_handshake_rejected", { reason: "bad_token" });
      conn.close();
      return;
    }
    const role = frame.role ?? "extension";
    if (role === "agent") {
      const id = `agent:${++this.agentSeq}`;
      this.agents.set(conn, { conn, id });
      this.deps.logger.info("browser_agent_connected", { id, client: frame.client });
      this.safeSend(conn, {
        v: PROTOCOL_VERSION,
        type: "ready",
        server: "opencode-browser",
        protocol: PROTOCOL_VERSION,
        role: "agent",
        clientId: id
      });
      return;
    }
    const id = frame.id || `exec:${++this.execSeq}`;
    // Replace any stale connection carrying the same id (extension reconnect).
    const prior = this.executorById.get(id);
    if (prior && prior.conn !== conn) {
      this.executors.delete(prior.conn);
      prior.conn.close();
    }
    const info: ExecutorInfo = {
      conn,
      id,
      label: frame.label || id,
      browser: frame.browser || "unknown"
    };
    this.executors.set(conn, info);
    this.executorById.set(id, info);
    if (!this.primaryExecutorId || !this.executorById.has(this.primaryExecutorId)) {
      this.primaryExecutorId = id;
    }
    this.deps.logger.info("browser_executor_connected", {
      id,
      label: info.label,
      browser: info.browser
    });
    this.safeSend(conn, {
      v: PROTOCOL_VERSION,
      type: "ready",
      server: "opencode-browser",
      protocol: PROTOCOL_VERSION,
      role: "extension",
      clientId: id,
      executor: this.opts.executor
    });
    // Rebuild group ownership from the executor's existing tabs (recovers after a
    // broker re-election; groups come back orphaned and are adopted on first use).
    void this.rebuildFromExecutor(info);
  }

  private async rebuildFromExecutor(executor: ExecutorInfo): Promise<void> {
    try {
      const data = (await this.sendToExecutor(executor, "broker", {
        action: "tabs",
        group: "",
        params: {}
      })) as { groups?: Array<{ name?: string }> };
      for (const g of data.groups ?? []) {
        if (g.name && !this.groupOwner.has(g.name)) {
          this.groupOwner.set(g.name, { executorId: executor.id, agentId: null });
        }
      }
    } catch {
      /* best-effort */
    }
  }

  private onClose(conn: ClientConnection): void {
    const executor = this.executors.get(conn);
    if (executor) {
      this.executors.delete(conn);
      // Only forget the id mapping if it still points at this connection.
      if (this.executorById.get(executor.id)?.conn === conn) {
        this.executorById.delete(executor.id);
        for (const [group, owner] of this.groupOwner) {
          if (owner.executorId === executor.id) {
            this.groupOwner.delete(group);
          }
        }
        for (const [reqId, p] of this.pending) {
          if (p.executorId === executor.id) {
            this.settleReject(reqId, new BrokerError("the browser disconnected", "executor_gone"));
          }
        }
      }
      if (this.primaryExecutorId === executor.id) {
        this.primaryExecutorId = this.executorById.keys().next().value ?? null;
      }
      this.deps.logger.info("browser_executor_disconnected", { id: executor.id });
      return;
    }
    const agent = this.agents.get(conn);
    if (agent) {
      this.agents.delete(conn);
      // Orphan this agent's groups (adoptable by the next user) AND send a
      // release frame to the executors it owned, so a guest agent dropping
      // (MCP server / guest OpenCode exit) detaches the CDP debugger/banner
      // instead of leaving it attached until a later manual release.
      this.releaseForAgent(agent.id);
      for (const [reqId, p] of this.pending) {
        if (p.agentId === agent.id) {
          // The executor may still be running this command — cancel it so any
          // open UI (e.g. a feedback overlay) is torn down, not just orphaned.
          this.abandon(reqId, new BrokerError("agent disconnected", "agent_gone"));
        }
      }
      this.deps.logger.info("browser_agent_disconnected", { id: agent.id });
    }
  }

  // ─── routing ───────────────────────────────────────────────────────────────
  private route(
    agentId: string,
    cmd: {
      action: BrowserAction;
      group: string;
      params: Record<string, unknown>;
      target?: string;
      timeoutMs?: number;
    },
    signal?: AbortSignal
  ): Promise<unknown> {
    if (cmd.action === "targets") {
      return Promise.resolve(this.listTargets());
    }
    if (cmd.action === "release") {
      this.releaseForAgent(agentId);
      return Promise.resolve({ ok: true });
    }
    if (cmd.action === "tabs" && !cmd.group) {
      return this.aggregateTabs();
    }
    let executor: ExecutorInfo;
    try {
      executor = GLOBAL_ACTIONS.has(cmd.action)
        ? this.pickExecutor(cmd.target)
        : this.resolveExecutor(agentId, cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.sendToExecutor(executor, agentId, cmd, signal);
  }

  private resolveExecutor(
    agentId: string,
    cmd: { action: BrowserAction; group: string; target?: string }
  ): ExecutorInfo {
    const owner = this.groupOwner.get(cmd.group);
    if (owner) {
      if (owner.agentId && owner.agentId !== agentId) {
        throw new BrokerError(`group "${cmd.group}" is owned by another client`, "group_owned");
      }
      owner.agentId = agentId; // claim (incl. adopting an orphan)
      const exec = this.executorById.get(owner.executorId);
      if (!exec) {
        throw new BrokerError(
          `the browser for group "${cmd.group}" is disconnected`,
          "executor_gone"
        );
      }
      return exec;
    }
    if (cmd.action !== "open") {
      throw new BrokerError(
        `group "${cmd.group}" has no open tabs — call browser_open first`,
        "no_group"
      );
    }
    const exec = this.pickExecutor(cmd.target);
    this.groupOwner.set(cmd.group, { executorId: exec.id, agentId });
    return exec;
  }

  private pickExecutor(target?: string): ExecutorInfo {
    if (this.executorById.size === 0) {
      throw new BrokerError(
        "no browser extension is connected to the bridge — open the extension and confirm it shows 'connected'",
        "not_connected"
      );
    }
    if (target) {
      const byId = this.executorById.get(target);
      if (byId) {
        return byId;
      }
      const byLabel = [...this.executorById.values()].filter((e) => e.label === target);
      if (byLabel.length === 1) {
        return byLabel[0];
      }
      if (byLabel.length > 1) {
        throw new BrokerError(
          `target "${target}" is ambiguous — use the browser id`,
          "ambiguous_target"
        );
      }
      throw new BrokerError(`no connected browser matches target "${target}"`, "unknown_target");
    }
    const primary = this.primaryExecutorId
      ? this.executorById.get(this.primaryExecutorId)
      : undefined;
    if (primary) {
      return primary;
    }
    for (const exec of this.executorById.values()) {
      return exec;
    }
    throw new BrokerError("no browser extension is connected", "not_connected");
  }

  /** Effective per-command timeout: the override (or global), clamped to the ceiling. */
  private timeoutFor(override?: number): number {
    const requested = override !== undefined ? override : this.opts.timeoutMs;
    if (requested <= 0) {
      return 0;
    }
    const ceiling = this.opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
    return Math.min(requested, ceiling);
  }

  private sendToExecutor(
    executor: ExecutorInfo,
    agentId: string,
    cmd: {
      action: BrowserAction;
      group: string;
      params: Record<string, unknown>;
      timeoutMs?: number;
    },
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new BrokerError("aborted", "aborted"));
    }
    const reqId = nextId();
    const frame: CommandFrame = {
      v: PROTOCOL_VERSION,
      type: "command",
      id: reqId,
      action: cmd.action,
      group: cmd.group,
      params: cmd.params
    };
    const timeoutMs = this.timeoutFor(cmd.timeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(
              () =>
                this.abandon(
                  reqId,
                  new BrokerError(
                    `command '${cmd.action}' timed out after ${timeoutMs}ms`,
                    "timeout"
                  )
                ),
              timeoutMs
            )
          : null;
      let detachAbort: (() => void) | null = null;
      if (signal) {
        const onAbort = () => this.abandon(reqId, new BrokerError("aborted", "aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(reqId, {
        resolve,
        reject,
        timer,
        detachAbort,
        agentId,
        executorId: executor.id
      });
      try {
        executor.conn.send(encodeFrame(frame));
      } catch (err) {
        this.settleReject(
          reqId,
          new BrokerError(
            `failed to deliver '${cmd.action}': ${err instanceof Error ? err.message : String(err)}`,
            "send_failed"
          )
        );
      }
    });
  }

  private handleResult(frame: Frame & { type: "result" }): void {
    const p = this.pending.get(frame.id);
    if (!p) {
      return;
    }
    this.clearPending(frame.id);
    if (frame.ok) {
      p.resolve(frame.data);
    } else {
      p.reject(new BrokerError(frame.error?.message ?? "executor error", frame.error?.code));
    }
  }

  private async handleAgentCommand(
    agent: AgentInfo,
    conn: ClientConnection,
    frame: CommandFrame
  ): Promise<void> {
    try {
      const data = await this.route(agent.id, {
        action: frame.action,
        group: frame.group,
        params: frame.params,
        target: frame.target,
        timeoutMs: frame.timeoutMs
      });
      this.safeSend(conn, resultFrame(frame.id, data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof BrokerError ? err.code : undefined;
      this.safeSend(conn, errorFrame(frame.id, message, code));
    }
  }

  private routeEvent(frame: EventFrame): void {
    // Forward to the owning agent if known, else broadcast to all remote agents.
    const owner = frame.group ? this.groupOwner.get(frame.group) : undefined;
    for (const agent of this.agents.values()) {
      if (!owner || owner.agentId === null || owner.agentId === agent.id) {
        this.safeSend(agent.conn, frame);
      }
    }
  }

  private listTargets(): {
    targets: Array<{ id: string; label: string; browser: string; groups: string[] }>;
  } {
    return {
      targets: [...this.executorById.values()].map((e) => ({
        id: e.id,
        label: e.label,
        browser: e.browser,
        groups: [...this.groupOwner.entries()]
          .filter(([, o]) => o.executorId === e.id)
          .map(([g]) => g)
      }))
    };
  }

  private async aggregateTabs(): Promise<{ groups: unknown[] }> {
    const groups: unknown[] = [];
    for (const executor of this.executorById.values()) {
      try {
        const data = (await this.sendToExecutor(executor, "broker", {
          action: "tabs",
          group: "",
          params: {}
        })) as { groups?: unknown[] };
        for (const g of data.groups ?? []) {
          groups.push({ ...(g as object), executor: executor.id });
        }
      } catch {
        /* skip a browser that errored */
      }
    }
    return { groups };
  }

  private releaseForAgent(agentId: string): void {
    const execIds = new Set<string>();
    for (const owner of this.groupOwner.values()) {
      if (owner.agentId === agentId) {
        execIds.add(owner.executorId);
        owner.agentId = null;
      }
    }
    // Only release the executors this agent actually owned. An agent that holds
    // no groups must release nothing — broadcasting to every executor would
    // detach CDP control from other clients' browsers in a shared bridge.
    for (const id of execIds) {
      const exec = this.executorById.get(id);
      if (exec) {
        this.safeSend(exec.conn, { v: PROTOCOL_VERSION, type: "release" });
      }
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────
  private safeSend(conn: ClientConnection, frame: Frame): void {
    try {
      conn.send(encodeFrame(frame));
    } catch {
      /* connection went away; close handler cleans up */
    }
  }

  private clearPending(reqId: string): void {
    const p = this.pending.get(reqId);
    if (!p) {
      return;
    }
    if (p.timer) {
      clearTimeout(p.timer);
    }
    p.detachAbort?.();
    this.pending.delete(reqId);
  }

  private settleReject(reqId: string, err: Error): void {
    const p = this.pending.get(reqId);
    if (!p) {
      return;
    }
    this.clearPending(reqId);
    p.reject(err);
  }

  /**
   * Give up on a command the executor may still be running (abort, timeout, or
   * the requesting agent vanishing): tell the still-connected executor to tear
   * down via a `cancel` frame, then reject the pending promise. For an executor
   * that's already gone the cancel is skipped — there's nothing to tear down.
   */
  private abandon(reqId: string, err: Error): void {
    const p = this.pending.get(reqId);
    if (!p) {
      return;
    }
    const exec = this.executorById.get(p.executorId);
    if (exec) {
      this.safeSend(exec.conn, cancelFrame(reqId));
    }
    this.settleReject(reqId, err);
  }

  private rejectAllPending(err: Error): void {
    for (const [reqId, p] of this.pending) {
      if (p.timer) {
        clearTimeout(p.timer);
      }
      p.detachAbort?.();
      this.pending.delete(reqId);
      p.reject(err);
    }
  }
}
