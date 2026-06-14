# ADR-0001 — Browser-bridge transport: the `ws` package, not `Bun.serve` or socket.io

- **Status:** Accepted — shipped in `@vymalo/opencode-browser@0.7.3` ([#46](https://github.com/vymalo/opencode-oauth2/pull/46), 2026-06-14).
- **Scope:** `@vymalo/opencode-browser` and `@vymalo/opencode-browser-mcp` (the bridge/broker
  WebSocket layer that the companion extension dials).

## Context

The browser feature is a **dual plugin**: an OpenCode plugin (and an MCP server) hosts a
localhost WebSocket **bridge**, and the companion browser extension's background worker
dials *out* to it (extensions can't host servers; a service worker can open an outbound
socket). The bridge is an auto-elect **broker** — the first process to bind the port hosts;
the rest join as guests; on a drop they re-elect — so multiple agents and multiple browsers
can share one bridge. See [`browser.md`](../browser.md) and
[`../plans/multi-client-routing.md`](../plans/multi-client-routing.md).

The bridge needs a server-side WebSocket implementation. The original build used
**`Bun.serve`**, on the assumption (encoded in the original plan) that *"OpenCode runs on
Bun."* That assumption was only half true:

- **OpenCode CLI** and **`opencode web`** run plugins under **Bun** — `Bun.serve` exists.
- The **OpenCode desktop app** runs plugins under **Node** — `Bun.serve` does **not** exist.

The symptom under the desktop app was a hard load failure:

```
failed to load plugin path=@vymalo/opencode-browser
  error="the opencode-browser bridge requires the Bun runtime (Bun.serve not found)"
```

So the bridge silently didn't start on desktop — the runtime where the extension companion
is most useful. We needed a server WebSocket that works under **both** Bun and Node from a
single code path.

## Decision

Standardize the host transport on the **[`ws`](https://www.npmjs.com/package/ws) npm
package** (a `WebSocketServer` for host mode and a `ws` client for guest mode), living in
`packages/opencode-browser/src/node-transport.ts` and exported via `./lib`.

- `ws` is a pure-JS WebSocket implementation that runs unmodified under **Node and Bun**
  (Bun implements the `ws` API), so one transport covers every runtime OpenCode loads the
  plugin in — no runtime branch, no `globalThis.Bun` probe.
- `@vymalo/opencode-browser-mcp` reuses the *same* transport from `@vymalo/opencode-browser/lib`
  rather than carrying its own Node copy.
- The transport stays behind the existing `BridgeTransport` seam (`transport.ts`), so the
  broker/endpoint election logic is unchanged and tests still inject a fake transport.

The `Bun.serve` transport and the Bun-specific agent socket were deleted outright — not kept
as a fallback. `ws` already covers the Bun case, so a second path would be dead weight.

## Consequences

**Positive**
- The bridge starts under the **desktop app** (Node) as well as the CLI/web (Bun) — the
  original bug is gone, from one code path.
- One transport to test and maintain; `-mcp` no longer ships a duplicate (it dropped its
  direct `ws` / `@types/ws` deps — now transitive).
- The election/broker/failover layer is untouched; the change is confined to the wire layer.

**Negative / cost**
- `@vymalo/opencode-browser` now carries a runtime dependency on `ws` (`^8.21.0`) plus
  `@types/ws` as a devDep. Acceptable: `ws` is the de-facto Node WebSocket library, tiny,
  and dependency-light.
- We lean on Bun's `ws` compatibility. It's solid and widely relied on, but it is a
  compatibility surface we don't control. If Bun ever regressed it, the fallback would be a
  thin runtime branch back to `Bun.serve` — cheap to add, which is partly why we didn't keep
  it pre-emptively.

## Alternatives considered

### Keep `Bun.serve` (status quo) — rejected
It's the cause of the desktop failure. A `Bun.serve`-here / `ws`-there runtime branch was
possible, but it means two host transports to maintain and test for zero benefit over
"just `ws` everywhere" — `ws` already runs under Bun.

### socket.io — rejected
Tempting because it ships reconnect, acks, rooms, and heartbeat out of the box. But for
*this* architecture it costs more than it gives:

1. **The extension client is the binding constraint.** An MV3 background worker can only
   dial out with the browser's native `WebSocket`. socket.io is **not** plain WebSocket
   (it's Engine.IO framing on top), so the extension would have to bundle `socket.io-client`
   (~10–15 kB gzipped) — larger than the extension's entire pruned CSS — to talk to it.
2. **It reopens the runtime question we just closed.** The `socket.io` server leans on
   Engine.IO + Node's `http.Server`; whether it behaves identically under Bun is another
   compatibility gamble — the exact class of risk this ADR exists to retire.
3. **Its headline features duplicate things we already own — and own coupled to the broker.**
   Reconnect/failover lives in `endpoint.ts`; request/response correlation in `protocol.ts`;
   "rooms" are our named **groups** with ownership routing in `broker.ts`. socket.io's
   polling fallback is irrelevant on `127.0.0.1`.
4. **It doesn't help with the actually-hard part.** The auto-**election** (N processes
   racing to bind one port, host-or-guest, failover) is a peer-discovery problem orthogonal
   to socket.io's client/server model. We'd keep all of `endpoint.ts`/`broker.ts` and gain
   nothing for the added bytes and risk.

socket.io would be the right call for a greenfield, Node-only service with a normal web
client and no existing protocol — the opposite of where this code is.

### Bare `ws` (chosen)
Smallest surface that satisfies the hard constraints: runs under Node *and* Bun, speaks
plain WebSocket so the extension's native client connects with zero added bundle, and slots
behind our existing transport seam without disturbing the broker.
