# Browser automation (`@vymalo/opencode-browser` + extension)

Give an OpenCode agent **hands in a real browser** — open tabs, click, type, scroll,
screenshot — scoped into **named groups** so each task's tabs stay isolated and inspectable.

This is a **dual plugin**:

| Half | Package | Role |
| --- | --- | --- |
| OpenCode plugin | `@vymalo/opencode-browser` (`packages/opencode-browser`) | Registers `browser_*` **tools** the model calls, and hosts a localhost **WebSocket bridge**. |
| Browser extension | `apps/browser-extension` (private, Chromium MV3 + Firefox) | A React/Tailwind/shadcn app whose background worker dials the bridge and drives real tabs. |

## Topology — why the plugin is the server

Browser extensions **cannot host servers**, but a background service worker *can* open an
outbound WebSocket to `127.0.0.1`. So the plugin hosts the bridge and the extension connects
out to it. OpenCode runs on **Bun**, so the bridge uses `Bun.serve`'s WebSocket support.

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

| Tool | Key args | Result |
| --- | --- | --- |
| `browser_open` | `group, url?, focus?` | Opens a tab in the group; returns `{ tabId, url, title }`. |
| `browser_navigate` | `group, url, tabId?` | Navigates the active (or given) tab. |
| `browser_click` | `group, ref?\|selector?\|x,y, button?` | Clicks an element. |
| `browser_double_click` | `group, ref?\|selector?\|x,y` | Double-clicks. |
| `browser_type` | `group, text, ref?/selector?, submit?` | Types into a field; optional Enter. |
| `browser_fill` | `group, fields: [{ ref?/selector, value }]` | Batch form fill. |
| `browser_select` | `group, ref?/selector, value\|values` | Sets `<select>` option(s). |
| `browser_scroll` | `group, deltaX?, deltaY?, to?` | Scrolls page or element. |
| `browser_press_key` | `group, key` | Presses a key / chord. |
| `browser_screenshot` | `group, fullPage?, tabId?` | **Writes a PNG to disk**, returns the path. |
| `browser_snapshot` | `group` | Accessibility/DOM snapshot with stable **refs**. |
| `browser_get_text` | `group, tabId?` | Visible text of the page. |
| `browser_wait` | `group, ms?\|selector?, state?` | Fixed delay or wait-for-selector. |
| `browser_tabs` | `group?` | Lists groups + tabs. |
| `browser_close` | `group, tabId?` | Closes a tab, or the whole group. |

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
| Screenshot | `Page.captureScreenshot`, full-page via `captureBeyondViewport` | `tabs.captureVisibleTab` (viewport only) |
| Banner | Shows Chrome's "being debugged" banner (intentional signal) | None |
| Browser | Chromium only | Chromium + Firefox |

`executor: "auto"` picks CDP when `chrome.debugger` is available, else content-script. The
**"being debugged" banner is a feature** — a visible indicator that automation is active. If
the user dismisses it, the extension transparently re-attaches on the next action.

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
