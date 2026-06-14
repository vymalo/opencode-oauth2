# UI feedback / human-in-the-loop (design)

Status: **design / not yet implemented.** Greenfield follow-up to the browser plugin + MCP server.
Builds on the routing in [`multi-client-routing.md`](multi-client-routing.md) and the ws transport in
[`docs/adr/0001-bridge-transport-ws-not-bun-serve-or-socketio.md`](../docs/adr/0001-bridge-transport-ws-not-bun-serve-or-socketio.md).

## Context

Today the bridge is **fully automated**: the agent issues `command` frames, the extension executes
them programmatically (CDP or content-script), and answers with a `result`. There is **no** human in
the loop anywhere — no overlay, no prompt, no `chrome.notifications` (verified across `background/`
and `entrypoints/`). The popup/options panels are read-only dashboards.

We want a second, *complementary* mode: when the agent is unsure what the user means, it can ask the
**user** to mark up the live page — click the element they meant, box a region, drop a comment — and
get that feedback back as structured data it can act on. "Show me which list" instead of guessing.

## The key insight: the control direction does **not** invert

This is tempting to model as "the UI drives the agent," but it isn't. The agent still **initiates**
(a normal tool call inside its turn). The only difference from a `click` is that the executor, instead
of acting programmatically, **renders an overlay and blocks on a human**, then returns the human's
input in the `ResultFrame`. So the whole feature lives inside the existing
`agent → command → executor → result` pipeline and is exposed to **both** the OpenCode plugin and the
MCP server for free.

```
agent: "which list did you mean?"
  → browser_request_feedback(group, mode:"element", prompt:"Click the list you meant")
      → command{action:"request_feedback"} ──▶ extension paints overlay, waits for the human
          ← human clicks an element
      ← result{ ok, data:{ annotations:[{ kind:"element", ref:"e42", selector:"…", text:"Inbox" }] } }
  → agent now has a concrete ref and proceeds
```

What is genuinely new is **two infra gaps** a blocking, human-paced command exposes — neither
specific to this feature, both worth fixing cleanly first (Phase 0).

## The two infra prerequisites (Phase 0)

### 1. A command-cancellation frame (the blocker)

Today, when an agent's `AbortSignal` fires (turn cancelled) or its timeout elapses, the broker
**rejects the local pending promise and sends nothing to the executor** — `broker.ts:426-429`:

```ts
if (signal) {
  const onAbort = () => this.settleReject(reqId, new BrokerError("aborted", "aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  detachAbort = () => signal.removeEventListener("abort", onAbort);
}
```

For a 50 ms `click` that's invisible. For a blocking overlay it means an **orphaned overlay stuck on
the user's page** after the agent has given up. So we add a broker→executor frame:

```ts
/** Server → extension: abandon an in-flight command; tear down any UI for it. */
export interface CancelFrame {
  v: number;
  type: "cancel";
  /** The command id being abandoned (matches a prior CommandFrame.id). */
  id: string;
}
```

The broker already records `executorId` in each `pending` entry, so on abort **or** timeout it can
send `cancel{id}` to that executor before clearing the pending entry. The executor's command-router
keeps a small `Map<id, () => void>` of teardown handlers for in-flight interactive commands and runs
the matching one. Non-interactive commands ignore `cancel` (idempotent no-op). This is generally
useful beyond this feature (any future long-running tool benefits), which is why it's Phase 0 and not
folded into the tool.

### 2. Per-command timeout override

Timeout is a single global `BrokerOptions.timeoutMs` (`broker.ts:411-423`); a tool call can't ask for
longer. A "wait for human" tool needs minutes while a `click` must still fail fast. Fix:

- `ToolSpec` gains optional `timeoutMs?: number` (catalog declares the tool's natural ceiling).
- The adapter (`tools.ts` / MCP `server.ts`) passes it through `send(...)`; the broker's
  `sendToExecutor` uses `cmd.timeoutMs ?? this.opts.timeoutMs`, **clamped to a hard max**
  (`maxCommandMs`, default ~10 min) so a tool can't hang the bridge forever.
- The interactive tool also accepts a user-facing `timeoutMs` arg (bounded by the same clamp) so the
  agent can say "wait up to 2 min."

These two together: the overlay either gets human input, self-times-out and returns a clean
"no response" result, or is torn down by `cancel` when the agent's turn ends. No orphans, no hangs.

## The tool: `browser_request_feedback`

One tool with a `mode`, not a zoo of tools (keeps the catalog and the model's choice simple).

```
browser_request_feedback(group, mode, prompt?, options?, timeoutMs?, target?, tabId?)
```

`mode` (enum):

| mode      | UI                                   | returns per annotation                         |
| --------- | ------------------------------------ | ---------------------------------------------- |
| `confirm` | branded yes/no bar                   | `{ kind:"confirm", value:boolean }`            |
| `choose`  | pick from agent-supplied `options[]` | `{ kind:"choice", value:string }`              |
| `point`   | click one spot                       | `{ kind:"point", x, y, ref?, selector? }`      |
| `region`  | drag a box                           | `{ kind:"region", rect, refs[] }`              |
| `element` | hover-highlight → click an element   | `{ kind:"element", ref, selector, text }`      |
| `comment` | any of the above + a free-text note  | the above shape plus `text`                    |

Result is a neutral `{ annotations: Annotation[]; screenshot? }` rendered via the existing
`NeutralResult` (`kind:"json"`, plus optionally `kind:"image"` — see below). The `Annotation` union
mirrors the table; every spatial annotation carries **both pixels and a resolved element `ref`**.

**Why refs matter.** Coordinates alone aren't actionable — the agent can't reconnect a pixel to the
DOM. By resolving the picked spot/region/element against the existing `data-ocb-ref` snapshot
machinery (the same refs `browser_snapshot` already emits), the agent gets back `ref:"e42"` and can
immediately `browser_click ref:e42`. This is the crux that makes feedback *useful* rather than just
informative.

**Optional marker-annotated screenshot.** Because `NeutralResult` already supports `kind:"image"`
(written to disk by the OpenCode adapter, inline image content for MCP), the tool can burn the user's
markers into a screenshot and return it — so the agent literally *sees* what was circled, not just
coordinates.

### Group: new opt-in `interactive` group

This changes UX semantics (the model can now block waiting on a human), so it should be **opt-in**,
like `debug` — not silently on. Add a fourth `ToolGroup` `"interactive"`, excluded from
`DEFAULT_GROUPS`. Operators enable it via the existing `groups` option. (Alternative: fold into
`control`; rejected because `control` is on by default and a tool that blocks on a human shouldn't be
implicitly available.)

## Where the overlay lives

**Primary: in-page overlay** — matches the vision (annotate the *real* UI in context). But it can
**not** reuse the one-shot `pageDispatch` (`page-actions.ts:32-53`): that function is serialized,
re-evaluated per call, and `await`ed to completion by `executeScript`. Blocking it for minutes is
fragile (page navigation tears down the execution context; the MV3 service worker can be killed). So:

- Inject a **persistent overlay content script** (its own self-contained injected module) that owns
  the overlay DOM and input capture.
- It talks back to the background worker over a **`chrome.runtime` port** (not a return value). The
  command-router registers a teardown handler keyed by command id, and **resolves the command when
  the port delivers the annotations** (or on `cancel`/timeout).
- The open port + the bridge WebSocket keep the MV3 worker alive for the wait. Document this as the
  one place the worker must not be allowed to idle out mid-command.

**Fallback: side-panel over a screenshot** — for hostile pages (CSP, shadow DOM, z-index wars) where
an injected overlay can't be trusted to render. Capture a screenshot, show it in the extension's own
chrome with annotation tools, map annotations back to page coords. The new daisyUI panel pattern +
[`guide-panel.tsx`](../apps/browser-extension/src/components/panels/guide-panel.tsx) (nord/aqua theme)
is the template — compose with it rather than hand-rolling.

**Getting the user's attention.** The agent and the human may be in different windows/tabs, so the
extension must signal a feedback request: `chrome.notifications`, a badge, a sound, and focusing the
target tab. Without this the agent silently blocks until timeout.

**"Is a human even there?"** The feature assumes a present human at that executor's browser —
meaningless in headless/CI routing. The tool must time out gracefully into a
`{ annotations: [], timedOut: true }` result the agent can reason about ("no human responded"),
never hang.

## Protocol changes

- New `CancelFrame` (`{ v, type:"cancel", id }`), broker→executor; add to the `Frame` union, to
  `decodeFrame`, and mirror into the extension's `shared/protocol.ts` copy.
- New `BrowserAction` `"request_feedback"`.
- `CommandFrame` is unchanged on the wire; the per-command timeout is a broker-internal `send`
  argument derived from the `ToolSpec`/args, **not** a wire field (executors don't need it — they
  rely on `cancel`).
- Optional: a `feedback_*` `EventFrame` name for progress (e.g. "overlay shown") if we want the agent
  to log that the human was prompted; not required for v1.

## Component changes

- **`protocol.ts`** (+ extension mirror): `CancelFrame`, `"request_feedback"` action.
- **`broker.ts`**: send `cancel` to the recorded `executorId` on abort/timeout before clearing
  `pending`; thread a per-command timeout through `sendToExecutor` with a `maxCommandMs` clamp.
- **`catalog.ts`**: `interactive` group; `browser_request_feedback` spec (`input`, `params`,
  `result`); `ToolSpec.timeoutMs?`; the `Annotation` neutral types.
- **`tools.ts` / MCP `server.ts`**: pass `timeoutMs` into `send`; render `{annotations, screenshot}`
  (json + optional image) — both adapters already handle json/image, so this is wiring, not new
  rendering.
- **Extension `command-router.ts`**: `request_feedback` case → open overlay port, register teardown,
  resolve on annotations; handle inbound `cancel` frames via the teardown map.
- **Extension (new)**: persistent overlay content script (point/region/element/confirm/choose/comment
  capture, ref resolution against `data-ocb-ref`); attention signals (notification/badge/focus);
  side-panel fallback UI composing the daisyUI panels.

## Security

This is a **trust upgrade**, not a risk: a deliberate human gate in an otherwise autonomous loop.
Caveats to honor:

- The overlay must be **unmistakably branded** as opencode-browser and **un-spoofable** by the page
  (so a malicious page can't fake the prompt to harvest a click), and always dismissible.
- The `interactive` group is **opt-in** (off by default) so blocking-on-human is never a surprise.
- Trust model otherwise unchanged: loopback bind + shared token; `cancel` is a trusted broker frame.

## Testing

- **Broker (pure, DI):** on abort and on timeout, a `cancel{id}` is sent to the owning executor and
  `pending` is cleared; per-command `timeoutMs` overrides the global and is clamped to `maxCommandMs`.
- **Protocol:** `decodeFrame` round-trips `CancelFrame`; unknown future frames still rejected.
- **Catalog:** `request_feedback` only appears when `interactive` is enabled; `result` shapes each
  `mode` into the right `Annotation`; ref-resolution mapping.
- **Extension (where harnessable):** teardown handler runs on `cancel`; overlay self-times-out into a
  `timedOut` result; port-delivered annotations resolve the command; worker stays alive across the
  wait.

## Phased rollout (each independently shippable & green)

0. **Infra:** `CancelFrame` + abort/timeout teardown; per-command `timeoutMs` with `maxCommandMs`
   clamp. No user-visible feature yet — pure protocol/broker, fully unit-testable.
1. **Minimal HITL:** `interactive` group + `browser_request_feedback` with `confirm` / `choose` /
   `point`; in-page overlay (port-based); ref resolution; attention signal. Delivers the core
   "click the thing you meant" scenario.
2. **Rich annotation:** `region` / `element` / `comment` modes; marker-annotated screenshot result;
   side-panel-over-screenshot fallback for hostile pages.

## Open decisions (need a call before Phase 1)

- **Overlay-primary vs side-panel-primary.** Recommended: in-page overlay primary, side-panel as
  hostile-page fallback (matches the "annotate the real UI" vision). Could flip to side-panel-primary
  if injected-overlay reliability across arbitrary sites proves too painful.
- **One tool with `mode` vs several tools.** Recommended: one `browser_request_feedback` with a
  `mode` enum (simpler catalog, simpler model choice).
- **New `interactive` group vs reuse `control`.** Recommended: new opt-in group (blocking-on-human is
  a UX change that shouldn't be on by default).
- **`maxCommandMs` ceiling value.** Proposed ~10 min. Needs a number.

## Status

Design **draft** — infra prerequisites (Phase 0) are well-specified and low-risk; the tool surface
and overlay mechanism are specified with the open decisions above flagged. Recommend landing Phase 0
as its own PR (protocol + broker + tests, no UI) so the `cancel`-frame change to the shared protocol
gets focused review, then Phase 1.
