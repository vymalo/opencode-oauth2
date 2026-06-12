# @vymalo/opencode-browser

> Give an OpenCode agent hands in a real browser — open tabs, click, type, scroll, screenshot —
> organized into **named tab groups**.

This is the **OpenCode plugin** half of a dual plugin. It registers `browser_*` tools the model
can call and hosts a localhost WebSocket **bridge**. A companion **browser extension**
(Chromium MV3 + Firefox) connects to the bridge and drives real tabs.

> Browser extensions can't host servers, so the plugin is the server and the extension dials
> out to it. The plugin runs on Bun (inside OpenCode) and serves the bridge with `Bun.serve`.

## Install

```jsonc
// opencode.json
{
  "plugin": [
    ["@vymalo/opencode-browser", { "port": 4517 }]
  ]
}
```

On first run with no `token`, the plugin generates one and logs it once
(`browser_bridge_token_generated`). Paste that into the extension's dashboard along with the
bridge URL (`ws://127.0.0.1:4517`).

Get the extension from the [`apps/browser-extension`](https://github.com/vymalo/opencode-oauth2/tree/main/apps/browser-extension)
directory of the repo, build it (`pnpm build`), and load it unpacked.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `host` | `"127.0.0.1"` | Bind interface (keep it loopback). |
| `port` | `4517` | Bridge port. |
| `token` | _generated_ | Shared secret the extension must present. |
| `executor` | `"auto"` | `auto` \| `cdp` \| `content` (forwarded to the extension). |
| `timeoutMs` | `30000` | Per-command timeout. |
| `screenshotDir` | `".opencode/browser"` | Screenshot output dir (relative → worktree). |

## Tools

`browser_open`, `browser_navigate`, `browser_click`, `browser_double_click`, `browser_type`,
`browser_fill`, `browser_select`, `browser_scroll`, `browser_press_key`, `browser_screenshot`,
`browser_snapshot`, `browser_get_text`, `browser_wait`, `browser_tabs`, `browser_close`.

Every tool takes a `group` (the named tab group). Prefer `browser_snapshot` to get stable
element **refs**, then target them with `browser_click({ ref })` etc. Screenshots are written to
disk — view them with OpenCode's `read` tool (tool output can't carry images).

## Security

The bridge binds `127.0.0.1` only and requires a token handshake. It gives the model control of
a real browser profile — **use a dedicated/throwaway Chrome profile**. The `chrome.debugger`
"being debugged" banner is an intentional signal that automation is active.

Full docs: [`docs/browser.md`](https://github.com/vymalo/opencode-oauth2/blob/main/docs/browser.md).

## License

MIT
