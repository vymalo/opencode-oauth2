# Browser automation (`@vymalo/opencode-browser` + extension)

Give an OpenCode agent **hands in a real browser** — open tabs, click, type, scroll,
screenshot — scoped into **named groups** so each task's tabs stay isolated and inspectable.

This is a **dual plugin**:

| Half | Package | Role |
| --- | --- | --- |
| OpenCode plugin | `@vymalo/opencode-browser` (`packages/opencode-browser`) | Registers `browser_*` **tools** the model calls, and hosts a localhost **WebSocket bridge**. |
| Browser extension | `apps/browser-extension` (private, Chromium MV3 + Firefox) | A React/Tailwind/shadcn app whose background worker dials the bridge and drives real tabs. |

## Topology — an auto-elect broker

Browser extensions **cannot host servers**, but a background service worker *can* open an
outbound WebSocket to `127.0.0.1`. So an **agent** (the plugin or the MCP server) hosts the
bridge and the extension connects out to it. OpenCode runs on **Bun**, so the bridge uses
`Bun.serve`; the MCP server uses Node `ws`.

The bridge is a **broker** with two roles: **agents** (producers — the plugin, the MCP server,
extra sessions) and **executors** (the browser extensions). The first agent to start wins the
port bind and runs the broker in-process; later agents detect the bound port and connect as
**guests**. If the host exits, a guest re-binds and takes over. This means you can run the
plugin and the MCP server (or several sessions) at once — see [Multiple browsers & agents](#multiple-browsers--agents).

```
OpenCode (Bun)                                   Browser (Chromium / Firefox)
┌────────────────────────────┐                   ┌─────────────────────────────────┐
│ @vymalo/opencode-browser   │                   │ extension background worker     │
│  • browser_* tools         │   ws://127.0.0.1  │  • BridgeClient (dials out)     │
│  • Bridge (Bun.serve) ◀────┼───────────────────┼──▶ CommandRouter                │
│      command  ───────────▶ │     :4517         │     • GroupRegistry (tab groups)│
│      ◀─────────── result   │                   │     • CdpExecutor / Content…    │
└────────────────────────────┘                   │  • IndexedDB (Dexie) ◀─ dashboard│
                                                  └─────────────────────────────────┘
```

The model calls e.g. `browser_open(group: "research", url: …)`. The tool's `execute` sends a
`command` frame over the bridge; the extension performs it and returns a `result`; the tool
shapes that into output for the model.

## Setup

### 1. Enable the plugin

Add it to your OpenCode config (or serve it from a `.well-known/opencode` document). The
second tuple element is the plugin's options:

```jsonc
{
  "plugin": [
    ["@vymalo/opencode-browser", { "port": 4517 }]
  ]
}
```

Options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When `false` the bridge never starts. |
| `host` | `"127.0.0.1"` | Interface to bind. Keep it loopback. |
| `port` | `4517` | WebSocket bridge port. |
| `token` | _generated_ | Shared secret the extension must present. If omitted, a random token is generated and **logged once** (`browser_bridge_token_generated`) — copy it into the extension. |
| `executor` | `"auto"` | Forwarded executor preference: `auto` \| `cdp` \| `content`. |
| `groups` | `["page","control"]` | Which tool groups to register (`page` \| `control` \| `debug`). `debug` is opt-in. |
| `timeoutMs` | `30000` | Per-command timeout before the tool call rejects. |
| `screenshotDir` | `".opencode/browser"` | Where screenshots are written (relative paths resolve against the session worktree). |

On first run with no `token`, watch the log for:

```
browser_bridge_token_generated  paste_into_extension=<token>
```

### 2. Load the extension

```sh
cd apps/browser-extension
pnpm build              # → .output/chrome-mv3
pnpm zip                # → packaged .zip for the store / unpacked load
```

- **Chrome/Edge/Brave**: `chrome://extensions` → enable Developer mode → *Load unpacked* →
  pick `.output/chrome-mv3`.
- **Firefox**: `pnpm build:firefox` → `about:debugging` → *Load Temporary Add-on* →
  pick `.output/firefox-mv2/manifest.json`.

Open the extension's **dashboard** (toolbar icon → *Dashboard*), paste the bridge URL
(`ws://127.0.0.1:4517`) and the token, pick an executor, and *Save & reconnect*. The popup
and dashboard show **Connected** once the handshake succeeds.

## Tools

`group` is the primary handle on every tool — it names the tab group the action targets, and
the extension creates it on the first `browser_open`.

The 32 tools are organized into three **groups**, gated by the `groups` option (plugin) /
`OCB_GROUPS` (MCP). Default: `page` + `control` (`debug` is opt-in). The `browser_*` names are
stable, so OpenCode's per-agent tool allow/deny works on them directly too.

**`page`** — observe (read-mostly):

| Tool | Key args | Result |
| --- | --- | --- |
| `browser_snapshot` | `group` | Accessibility/DOM snapshot with stable **refs**. |
| `browser_get_text` | `group, tabId?` | Visible text of the page. |
| `browser_get_html` | `group, ref?/selector?, outer?` | HTML of the page or an element. |
| `browser_get_attribute` | `group, ref?/selector?, name?` | Tag, text, value, checked, box, attributes. |
| `browser_query` | `group, selector, limit?` | Matching elements, each with a ref. |
| `browser_screenshot` | `group, fullPage?, tabId?` | PNG (disk path in OpenCode; inline image in MCP). |
| `browser_tabs` | `group?` | Lists groups + tabs. |

**`control`** — drive:

| Tool | Key args | Result |
| --- | --- | --- |
| `browser_open` | `group, url?, focus?` | Opens a tab in the group. |
| `browser_navigate` | `group, url, tabId?` | Navigates the active (or given) tab. |
| `browser_back` / `browser_forward` / `browser_reload` | `group, tabId?` | History nav / reload. |
| `browser_click` | `group, ref?\|selector?\|x,y, button?` | Clicks (left/middle/right). |
| `browser_double_click` | `group, ref?\|selector?\|x,y` | Double-clicks. |
| `browser_hover` | `group, ref?\|selector?\|x,y` | Hovers (reveals menus/tooltips). |
| `browser_drag` | `group, fromRef?/fromSelector?, ref?/selector?` | Drag-and-drop. |
| `browser_type` | `group, text, ref?/selector?, submit?` | Types into a field; optional Enter. |
| `browser_fill` | `group, fields: [{ ref?/selector, value }]` | Batch form fill. |
| `browser_select` | `group, ref?/selector, value\|values` | Sets `<select>` option(s). |
| `browser_scroll` | `group, deltaX?, deltaY?, to?` | Scrolls page or element. |
| `browser_press_key` | `group, key` | Presses a key / chord. |
| `browser_upload` | `group, ref?/selector, paths[]` | Sets a file `<input>` (CDP only). |
| `browser_wait` | `group, ms?\|selector?, state?` | Fixed delay or wait-for-selector. |
| `browser_activate` | `group, tabId?` | Brings a tab to the foreground. |
| `browser_close` | `group, tabId?` | Closes a tab, or the whole group. |
| `browser_release` | — | Releases control (detaches the debugger) without closing tabs. |

**`debug`** — powerful / sensitive (**off by default**; mostly CDP/Chromium-only):

| Tool | Key args | Result |
| --- | --- | --- |
| `browser_eval` | `group, code` | Evaluates JS in the page DOM, returns the result. |
| `browser_console` | `group` | Recent console output (CDP only). |
| `browser_network` | `group` | Recent network requests (CDP only). |
| `browser_handle_dialog` | `group, accept?, promptText?` | Accept/dismiss a JS dialog (CDP only). |
| `browser_set_viewport` | `group, width, height, mobile?` | Emulate a viewport (CDP only). |
| `browser_cookies` | `op, url?, name?, value?` | Read/modify cookies. |

### Targeting elements — prefer refs

`browser_snapshot` walks the page, tags interactive elements with a `data-ocb-ref` attribute
(`e1, e2, …`), and returns lines like:

```
e3	button	"Search"
e4	a	"Home" → https://example.com/
e7	input [email]	"you@example.com"
```

Pass those refs to `browser_click({ ref: "e3" })` etc. Refs are stable within a single
snapshot and far more reliable than guessing CSS selectors. You can still use `selector` or
absolute `x`/`y` coordinates.

### Screenshots — disk + the `read` tool

OpenCode tool results are **text only** — there's no image channel. So `browser_screenshot`
writes the PNG to `<worktree>/.opencode/browser/<group>/<timestamp>.png` and returns the path.
The model then **`read`s that path** to view the image (OpenCode's `read` tool emits an image
part). The extension also keeps a copy in IndexedDB for the dashboard gallery.

## Named groups

On **Chromium** a group maps to a real titled **tab group** (`chrome.tabs.group` +
`chrome.tabGroups.update`). On **Firefox** there is no tab-groups API, so the extension keeps a
**logical** registry only (tabs still work; they just aren't visually grouped). This degrades
gracefully and is the only meaningful Firefox difference besides the executor.

## Executors — CDP vs content-script

The trusted-input surface (click/type/key) and screenshots have two backends; everything else
(snapshot, text, scroll, fill, select, wait) is DOM-only and runs identically via
`chrome.scripting.executeScript`.

| | `cdp` (Chromium) | `content` (fallback / Firefox) |
| --- | --- | --- |
| Input | **Trusted** CDP events (`Input.dispatch*`) — `isTrusted: true` | Synthetic DOM events (`isTrusted: false`) |
| Screenshot | `Page.captureScreenshot`, full-page via `captureBeyondViewport` | `tabs.captureVisibleTab` + **scroll-and-stitch** for full-page (OffscreenCanvas) |
| Banner | Shows Chrome's "being debugged" banner (intentional signal) | None |
| Browser | Chromium only | Chromium + Firefox |

Synthetic key events on the content-script executor don't trigger the browser's native editing
actions, so the extension applies the common ones (Backspace/Delete/Enter in inputs) itself —
trusted shortcuts and rarer keys are only reliable on the CDP executor.

Full-page screenshots on the content executor are produced by **scroll-and-stitch**: the page
is scrolled one viewport at a time, each slice captured with `tabs.captureVisibleTab`, and the
slices composited onto an `OffscreenCanvas`. Two caveats vs CDP's native full-page capture:
`position: fixed` elements repeat in each slice, and very tall pages are captured up to a
safety cap (≈20 viewports / 16k device px) and reported as `partial` in the tool output.

`executor: "auto"` picks CDP when `chrome.debugger` is available, else content-script. The
**"being debugged" banner is a feature** — a visible indicator that automation is active. If
the user dismisses it, the extension transparently re-attaches on the next action.

**Precedence.** The executor is normally chosen in the extension's dashboard. If the operator
sets the plugin's `executor` option, the plugin advertises it in the handshake and the
extension adopts it **on each connect** (overriding the dashboard choice) — useful for
`.well-known/opencode` server-shipped config. Leave the plugin option unset to let the
dashboard be authoritative.

## Stopping / releasing control

Handing the browser back is the **plugin's** job — you shouldn't have to click
Disconnect. Three things release control (detach the CDP debugger; tabs stay open and a later
command transparently re-attaches):

- **`browser_release`** — the model/plugin calls it when done. The bridge sends a `release`
  frame and the extension detaches.
- **OpenCode exits** — the plugin's `exit` hook calls `bridge.shutdown()` (a `release` frame +
  server stop), and the dropped socket independently triggers the extension to release. So a
  hard kill releases too.
- **Manual** — the dashboard's Disconnect still works, and so does the `chrome.debugger` banner's
  Cancel button.

## Wire protocol

Dependency-free JSON frames (canonical definition: `packages/opencode-browser/src/protocol.ts`;
the extension mirrors it at `apps/browser-extension/src/shared/protocol.ts`).

| Frame | Direction | Purpose |
| --- | --- | --- |
| `hello` | ext → server | Handshake; carries the token. |
| `ready` | server → ext | Handshake accepted. |
| `command` | server → ext | Perform an action (correlated by `id`). |
| `result` | ext → server | Reply (`ok` + `data` or `error`). |
| `event` | ext → server | Unsolicited (`tab_closed`, `navigated`, …). |
| `ping`/`pong` | both | Heartbeat. |

The bridge keeps a single authenticated client (latest valid `hello` wins), a pending-request
map with per-command timeout + `AbortSignal` wiring, and rejects all in-flight commands if the
extension disconnects.

## Security model

- The bridge binds **`127.0.0.1` only** and requires a **shared-token** handshake.
- It grants the model control of a **real browser profile** — use a **dedicated or throwaway
  Chrome profile**, not your daily one with logged-in sessions.
- The `chrome.debugger` banner is an intentional, visible "automation is on" signal.
- The token is logged once (auto-generated case) so you can paste it into the extension;
  provided tokens are never logged (the logger redacts `token`-like fields).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Tool error: *no browser extension is connected* | Extension isn't connected. Open the dashboard, check the URL/token, *Save & reconnect*. |
| Dashboard stuck *connecting* | Wrong port or the plugin didn't start the bridge. Check the OpenCode log for `browser_bridge_listening`. |
| *no token set* in the dashboard | Paste the `paste_into_extension` token from the plugin log (or set `token` in plugin options and use that). |
| `debugger attach failed` | Another debugger (DevTools) is attached, or you forced `cdp` on Firefox. Switch executor to `content`. |
| Screenshot path returned but model can't see it | Use the `read` tool on the returned path — tool output can't carry images. |
| Clicks ignored on a strict site | You're on the content-script executor (synthetic events). Switch to `cdp` on Chromium for trusted input. |

## Multiple browsers & agents

The broker routes by **group ownership**, so several browsers and several agents can share one
bridge:

- **Multiple browsers (executors).** Connect more than one extension (e.g. Chrome + Firefox, or
  two profiles). Give each a **label** in its dashboard (defaults to a generated id). `browser_targets`
  lists them as `{ id, label, browser, groups }`. Choose where a new group opens with `target` on
  `browser_open` (`browser_open(group:"research", target:"work-chrome")`); later commands for that
  group follow it automatically. Omit `target` with a single browser.
- **Multiple agents (producers).** Run the plugin and the MCP server (or several sessions) at the
  same time — whichever starts first hosts the broker; the rest are guests. A group is **owned by
  the agent that created it**: another agent gets `group "X" is owned by another client`, so give
  your agents distinct group names. When an agent exits, its groups become **orphaned** and the
  next agent to use one adopts it (tabs survive).
- **Token sharing.** Adapters auto-share a token via a per-user `bridge.json` state file (set an
  explicit `token` / `OCB_TOKEN` to be deterministic on a simultaneous cold start). The extension
  still needs the token pasted in once.
- **Failover.** If the hosting agent quits, a guest re-binds and rebuilds group→browser ownership
  by re-querying each extension's tabs. During the brief re-election window commands fail fast with
  `bridge is re-electing` and the model retries.

Full design notes: [`plans/multi-client-routing.md`](../plans/multi-client-routing.md).

## Use it from other agents (MCP)

The browser tools aren't tied to OpenCode. **`@vymalo/opencode-browser-mcp`** is an MCP stdio
server that hosts the same bridge and exposes the same group-filtered `browser_*` tools over the
Model Context Protocol — so Claude Code, Cursor, Cline, Zed, etc. can drive the extension.
Screenshots come back as **inline image content** (no disk-path step).

```jsonc
// e.g. an MCP client config
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@vymalo/opencode-browser-mcp"],
      "env": { "OCB_TOKEN": "your-shared-token", "OCB_GROUPS": "page,control" }
    }
  }
}
```

Env: `OCB_TOKEN` (shared secret; generated + printed to stderr if unset), `OCB_PORT` (4517),
`OCB_HOST` (127.0.0.1), `OCB_GROUPS` (csv, default `page,control`). All logging goes to stderr
(stdout is the JSON-RPC stream). Paste the URL + token into the extension dashboard exactly as
with the plugin — the extension doesn't care which adapter is on the other end of the bridge.

The OpenCode plugin and the MCP server share one **tool catalog** (`catalog.ts`), so the two
surfaces never drift.

## Development

```sh
# Plugin
pnpm --filter @vymalo/opencode-browser build      # tsc → dist/
pnpm --filter @vymalo/opencode-browser test       # vitest

# Extension
cd apps/browser-extension
pnpm dev            # WXT dev server + HMR (Chrome)
pnpm dev:firefox    # WXT dev server (Firefox)
pnpm build          # production .output/chrome-mv3
pnpm zip            # packaged zip
pnpm typecheck      # wxt prepare && tsc --noEmit
```
