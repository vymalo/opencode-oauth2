# @vymalo/opencode-devtools-mcp

> The [`@vymalo/opencode-devtools`](../opencode-devtools) utilities for **any MCP client** — Claude
> Code, Cursor, Cline, Zed, …

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-devtools-mcp)](https://www.npmjs.com/package/@vymalo/opencode-devtools-mcp)
![node: >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

An MCP **stdio server** exposing the same local developer utilities (math, codec, crypto, datetime,
convert, http) over the Model Context Protocol. No bridge, no auth — each tool is pure in-process
compute. The MCP server and the OpenCode plugin share **one tool catalog**, so the two surfaces
never drift.

## Setup

```jsonc
{
  "mcpServers": {
    "devtools": {
      "command": "npx",
      "args": ["-y", "@vymalo/opencode-devtools-mcp"],
      "env": {
        "OCD_GROUPS": "math,codec,crypto,datetime,convert",
        "OCD_HTTP_ALLOW_PRIVATE": "0",
        "OCD_HTTP_TIMEOUT": "30000"
      }
    }
  }
}
```

| Env | Default | Meaning |
| --- | --- | --- |
| `OCD_GROUPS` | the 5 offline groups | Comma list of groups to expose (add `http` to enable egress). |
| `OCD_HTTP_ALLOW_PRIVATE` | `0` | `1` to let the `http` group reach loopback/private hosts (SSRF guard off). |
| `OCD_HTTP_TIMEOUT` | `30000` | Per-request timeout (ms). |

Logs go to **stderr** (stdout carries the MCP JSON-RPC stream).

Full tool reference and security model: [`docs/devtools.md`](../../docs/devtools.md).

## License

MIT
