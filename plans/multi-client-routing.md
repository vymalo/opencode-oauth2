# Multi-client routing (design)

Status: **design / not yet implemented.** Follow-up to the browser plugin + MCP server.

## Context

Today the bridge is single-everything: one connected extension (`client`), latest-`hello`-wins,
commands go to `this.client`, and each adapter (plugin / MCP server) hosts its **own** bridge
server. Consequences:

- Two adapters can't run at once — they contend for `127.0.0.1:4517` (second fails to bind), and
  an extension can only dial one of them.
- One agent can't drive more than one browser/profile.

## Goals (decided)

- **Both axes:** multiple **executors** (browsers) *and* multiple **producers** (agents — plugin +
  MCP, or several sessions) sharing one bridge.
- **Auto-elect embedded broker:** no separate daemon. The first adapter to start hosts the broker
  in-process; later adapters connect to it as clients; re-elect if the host exits.
- **Routing by group ownership (+ optional `target`):** the named group is the routing unit.

Non-goals (v1): cross-machine bridges; per-agent auth/tokens (one shared token); concurrent
drivers of the *same* group (groups are owner-exclusive).

## Roles on the wire

Every connection declares a role in `hello`:

```
hello { v, type:"hello", token, role:"agent"|"extension", label?,
        id?,        // extensions: stable per-install id (persisted in IndexedDB)
        browser? }  // extensions: "chrome" | "firefox" | UA hint
```

- **extension** = executor (drives tabs). Default when `role` is absent (back-compat with shipped
  builds). Sends a stable `id` (generated once, persisted) and a user-editable `label` from the
  dashboard (e.g. `work-chrome`).
- **agent** = producer (issues commands): the plugin, the MCP server, a guest adapter.

### Target identity (decided: dashboard label + auto-id fallback)

An agent names a browser by **label** or **id**. `browser_targets` lists connected executors as
`{ id, label, browser, groups[] }`; `browser_open`'s optional `target` accepts a label or an id
(label resolved to id; ambiguous label → error). Labels are edited in the extension dashboard and
default to the auto-id, so targeting works out of the box and reads nicely once labelled.

## The broker

Whoever wins election runs a role-aware broker holding:

- `executors: Map<connId, Conn>` — connected extensions (browsers).
- `agents: Map<connId, Conn>` — connected agents (incl. the host's own in-process loopback agent).
- `groupOwner: Map<group, { executorId, agentId }>` — who runs group G and who created it.
- `pending: Map<brokerReqId, { agentId, agentReqId }>` — to route results back.
- `primaryExecutor` — default executor for new groups when no `target` is given.

### Command flow

```
agent ──command{id,action,group,params,target?}──▶ broker ──command{id':…}──▶ executor
agent ◀──────────result{id}──────────────────────  broker  ◀──result{id'}──────
```

1. Broker resolves the executor:
   - **known group** → its `groupOwner.executorId` (error if that browser disconnected).
   - **new group** (`browser_open`) → the `target` executor, else `primaryExecutor`; record
     `groupOwner = { executor, agent }`.
   - **broker-handled** (`browser_targets`, `browser_release`) → answered/broadcast by the broker,
     not forwarded.
2. Broker mints `brokerReqId`, stores `pending`, forwards to the executor with the new id.
3. Executor `result{brokerReqId}` → broker maps back → `result{agentReqId}` to the origin agent.
4. Executor `event` → routed to the owning agent (tab/group events) or broadcast (generic).

### Isolation policy (decided: strictly owner-exclusive)

A group is owned by the **agent connection** that created it; only that connection may target it.
Another live agent gets `group "X" is owned by another client` — **no sharing, no cross-agent
handoff**. So the plugin and the MCP server must use **distinct group names**; they can't drive
each other's groups. Agents already choose names, so this is mostly a safety rail against two
producers stepping on the same tabs.

**Orphans.** Ownership is by *connection*. When the owning agent disconnects (normal exit, crash,
or failover), its groups become **orphaned and adoptable**: the next agent that references such a
group claims it (one-time). This is what keeps tabs usable after an agent goes away while still
forbidding *concurrent* cross-agent access. (Orphan ≠ sharing — only one live owner ever.)

## Auto-election & failover (the hard part)

**Election = the bind.** On startup an adapter tries to bind the port:

- **bind succeeds → host:** run the broker. The host's own tools call the broker **directly
  in-process** (not via a real loopback socket) — `connect()` returns a uniform `send()` that, in
  host mode, dispatches straight into the broker.
- **bind fails (EADDRINUSE) → guest:** connect to the running broker as an `agent` over WS (a new
  agent-side client, mirroring the extension's `BridgeClient`); `send()` goes over that socket.

The OS makes bind atomic, so simultaneous starts resolve cleanly (one host, rest guests).

**Shared token (so multi-agent stays zero-config).** A guest can't guess an auto-generated token,
so adapters coordinate via a per-user state file `<cacheDir>/opencode-browser/bridge.json`
(`{ port, token }`, mode `0600`): the host writes it on bind; guests read it to authenticate. If
the operator sets `token` explicitly (plugin option / `OCB_TOKEN`), that wins and is written to the
file. The **extension** still needs the token pasted into its dashboard (it can't read the FS) —
unchanged. Net: adapters auto-share; the human still pastes once.

**Failover when the host exits** (OpenCode quits / MCP server killed):

1. Its server socket closes → guests' agent connections and all executor connections drop.
2. Guests + extensions reconnect with backoff. On each retry a guest re-attempts the bind →
   **one guest wins election and becomes the new host/broker**; the rest reconnect as guests;
   extensions reconnect to the new host.
3. **State rebuild:** the dead broker's `groupOwner` map is gone. The new broker repopulates the
   *executor* side by querying each reconnected extension for its existing groups (the extension's
   `GroupRegistry` persists in IndexedDB), recording `group → executor`. The *agent* owner is
   unknown, so every pre-failover group is **orphaned** per the isolation rule above — the next
   agent to reference it adopts it. Tabs survive; live ownership re-forms on use.

**Accepted window (decided: fail-fast + retry):** during re-election (a few hundred ms to one
backoff interval) commands reject immediately with a clear `bridge re-electing` error and the
agent/model retries — no buffering/replay. This brief blip is the main cost of the no-daemon
choice and is documented for users.

## Protocol changes

- `HelloFrame`: `role?: "agent" | "extension"` (default extension), `label?`.
- `ReadyFrame`: `clientId` (assigned), `role` echo.
- `CommandFrame`: optional `target?` (broker-only; executors ignore).
- New broker→executor query to rebuild ownership: reuse the `tabs` action (returns the executor's
  groups) — no new frame needed.
- New tool **`browser_targets`** (group `page`): list connected browsers (broker answers).
- **`browser_open`** gains optional `target` to choose the browser for a new group.

## Component changes

- **`broker.ts`** (new, in `opencode-browser`): the role-aware broker — a generalization of today's
  `Bridge`, still behind the `BridgeTransport` seam (DI-testable: feed fake agent + executor conns,
  assert routing).
- **`agent-client.ts`** (new): connects to a broker over WS as `role:"agent"`, `send()` returns the
  correlated result (reuses the reconnect/backoff shape from the extension's `BridgeClient`).
- **`connect()`** (new, replaces direct `bridge.start()`): try-bind → host (broker + loopback
  agent) or guest (agent-client); exposes a uniform `send(action, group, params, signal)` to tools
  regardless of mode, plus failover re-election.
- **MCP server**: same `connect()` (Node `ws` for both the bind/broker and the guest client).
- **Extension**: `hello` sends `role:"extension"`; reconnect already handles a re-elected host. Add
  a small "report my groups" reply for ownership rebuild (the `tabs` handler already lists them).
- **Tools/catalog**: add `browser_targets`; add `target` to `browser_open`.

## Security

Unchanged trust model: loopback bind + one shared token; both roles present it. Owner-exclusive
groups add light isolation between agents. The token is still printed once by whoever generates it.

## Testing

- Broker routing (pure, DI): command→correct executor by group ownership; result correlation back
  to the origin agent; new-group target selection; owner-exclusivity rejection; event routing.
- Election: two fake transports racing the bind → exactly one host.
- Failover: kill host transport → a guest re-binds → ownership rebuilt from executors' `tabs`.
- agent-client: reconnect/backoff, result correlation, abort.

## Phased rollout (each independently shippable & green)

1. **Roles + multi-executor (Axis 1):** `hello.role`, broker with `groupOwner` routing, `target` +
   `browser_targets`, single host agent (in-process loopback). No guests yet.
2. **Guest agents (Axis 2):** `agent-client` + try-bind `connect()`; plugin & MCP become host-or-
   guest. Owner-exclusive groups.
3. **Failover:** guest re-election on host exit + ownership rebuild from executors; "re-electing"
   error + retry.

## Resolved decisions

- **Scope:** both axes (multi-executor + multi-agent).
- **Topology:** auto-elect embedded broker (no daemon); direct in-process broker call for the host.
- **Routing key:** group ownership + optional `target`.
- **Target identity:** dashboard label + stable auto-id fallback.
- **Group access:** strictly owner-exclusive; orphaned groups are adoptable once the owner is gone.
- **Re-election window:** fail-fast + retry (no buffering).
- **Token in multi-agent:** shared via a `0600` state file (`bridge.json`); explicit option wins.
- **Default executor** (multiple browsers, no `target`): **first-connected**, overridable by a
  "default browser" toggle in the dashboard.
- **Host symmetry:** **symmetric auto-elect** — plugin or MCP server may host; revisit only if
  failover proves flaky in practice.
- **`target` arg:** always present but **optional**; tool docs say "omit unless you have multiple
  browsers connected" to keep single-browser setups quiet.

## Status

Design **final** — ready to implement when picked up, phased: roles + multi-executor → guest
agents + auto-elect → failover. Build as its own PR off `main` after the browser plugin / MCP PR
lands, so the failover / re-election code gets focused review.
