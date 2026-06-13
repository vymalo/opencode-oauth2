# @vymalo/opencode-browser-mcp

> Drive a real browser from **any MCP client** — Claude Code, Cursor, Cline, Zed, … — via the
> [`@vymalo/opencode-browser`](../opencode-browser) extension.

An MCP **stdio server** that hosts the same localhost WebSocket **bridge** as the OpenCode
plugin and exposes the same `browser_*` tools (open, click, type, scroll, screenshot, snapshot,
…) over the Model Context Protocol. Screenshots are returned as **inline image content**.

It is not tied to OpenCode — the companion browser extension doesn't care which adapter is on
the other end of the bridge.

## Use it

```jsonc
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

Then load the extension (see the [extension README](../../apps/browser-extension/README.md)),
open its dashboard, and paste the bridge URL (`ws://127.0.0.1:4517`) and the same token.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `OCB_TOKEN` | _generated_ | Shared secret the extension must present (printed to stderr if unset). |
| `OCB_HOST` | `127.0.0.1` | Bridge bind host. |
| `OCB_PORT` | `4517` | Bridge port. |
| `OCB_GROUPS` | `page,control` | Tool groups to expose (`page` \| `control` \| `debug`, comma-separated). |

All logging goes to **stderr** — stdout is the MCP JSON-RPC stream.

## Tools & groups

Same 32-tool surface as the plugin, grouped into `page` / `control` / `debug` (debug off by
default). Full reference: [`docs/browser.md`](https://github.com/vymalo/opencode-oauth2/blob/main/docs/browser.md).

## License

MIT
