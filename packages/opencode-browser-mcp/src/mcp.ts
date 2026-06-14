#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createEndpoint,
  createNodeAgentSocket,
  createNodeTransport,
  DEFAULT_GROUPS,
  type Logger,
  resolveSharedToken,
  TOOL_GROUPS,
  type ToolGroup,
  writeBridgeFile
} from "@vymalo/opencode-browser/lib";

import { createMcpServer } from "./server.js";

// IMPORTANT: stdout carries the MCP JSON-RPC stream — all logging goes to stderr.
function stderrLogger(): Logger {
  const write =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>): void => {
      process.stderr.write(`[${level}] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`);
    };
  return { debug: () => {}, info: write("info"), warn: write("warn"), error: write("error") };
}

function resolveGroups(raw: string | undefined): ToolGroup[] {
  if (!raw) {
    return [...DEFAULT_GROUPS];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((g): g is ToolGroup => TOOL_GROUPS.includes(g as ToolGroup));
  return parts.length > 0 ? parts : [...DEFAULT_GROUPS];
}

async function main(): Promise<void> {
  const host = process.env.OCB_HOST ?? "127.0.0.1";
  const port = Number(process.env.OCB_PORT ?? 4517);
  const groups = resolveGroups(process.env.OCB_GROUPS);
  const logger = stderrLogger();

  // Share the token with any other adapter on this machine (explicit env wins).
  const { token, source } = resolveSharedToken(port, process.env.OCB_TOKEN, () =>
    randomBytes(24).toString("hex")
  );
  writeBridgeFile(port, token);

  const endpoint = await createEndpoint(
    { host, port, token, timeoutMs: 90_000, label: "opencode-browser-mcp" },
    {
      logger,
      createServerTransport: createNodeTransport,
      createAgentSocket: createNodeAgentSocket
    }
  );

  process.stderr.write(`opencode-browser-mcp: bridge ws://${host}:${port} (${endpoint.mode()})\n`);
  if (source !== "explicit") {
    process.stderr.write(`opencode-browser-mcp: token ${token}\n`);
  }
  process.stderr.write(`opencode-browser-mcp: groups ${groups.join(", ")}\n`);
  process.stderr.write(
    "opencode-browser-mcp: paste the URL + token into the extension dashboard.\n"
  );

  const shutdown = () => {
    try {
      endpoint.shutdown();
    } catch {
      /* best-effort */
    }
  };
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.once("exit", shutdown);

  const server = createMcpServer(endpoint.send, groups);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(
    `opencode-browser-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
