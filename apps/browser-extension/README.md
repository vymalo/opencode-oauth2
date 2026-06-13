# OpenCode Browser — extension

Companion Chromium/Firefox extension for [`@vymalo/opencode-browser`](../../packages/opencode-browser).
Its background worker dials the plugin's localhost bridge and drives real browser tabs (open,
click, type, scroll, screenshot) on behalf of an OpenCode agent, organized into named tab groups.

Built with **WXT** (cross-browser MV3), **React + Tailwind + shadcn-style UI**, **TanStack
Query**, and **Dexie/IndexedDB**.

## Develop

```sh
pnpm dev            # WXT dev server + HMR (Chrome)
pnpm dev:firefox    # WXT dev server (Firefox)
pnpm build          # production build → .output/chrome-mv3
pnpm build:firefox  # → .output/firefox-mv2
pnpm zip            # packaged .zip for store / unpacked load
pnpm typecheck      # wxt prepare && tsc --noEmit
pnpm test           # vitest (pure helpers)
```

## Load it

- **Chrome/Edge/Brave**: `chrome://extensions` → Developer mode → *Load unpacked* →
  `.output/chrome-mv3`.
- **Firefox**: `about:debugging` → *Load Temporary Add-on* → `.output/firefox-mv2/manifest.json`.

Then open the toolbar popup → *Dashboard*, paste the bridge URL (`ws://127.0.0.1:4517`) and the
token printed by the plugin, choose an executor, and *Save & reconnect*.

## Layout

```
src/
├── entrypoints/
│   ├── background.ts        # service worker — wires the engine
│   ├── popup/               # compact status + connect toggle
│   └── options/             # full dashboard (connection / activity / screenshots)
├── background/              # BridgeClient, CommandRouter, GroupRegistry, executors, page-actions
├── shared/                  # protocol (mirror), types, Dexie db, messages
├── components/ + lib/       # shadcn-style UI kit, hooks, helpers
└── styles/globals.css       # Tailwind v4 theme tokens
```

The two executors share all DOM-bound work via `chrome.scripting.executeScript`. The CDP
executor (`chrome.debugger`) adds trusted input + full-page capture on Chromium; the
content-script executor is the Firefox-safe fallback. See
[`docs/browser.md`](../../docs/browser.md) for the full architecture.

This package is **private** — it is not published to npm; distribute the built `.zip`.
