#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_GROUPS, resolveOptions, TOOL_GROUPS } from "@vymalo/opencode-devtools/lib";

import { createMcpServer, groupsFromEnv } from "./server.js";

async function main(): Promise<void> {
  const groups = groupsFromEnv(process.env.OCD_GROUPS, TOOL_GROUPS, DEFAULT_GROUPS);
  const options = resolveOptions({
    groups,
    http: {
      allowPrivateNetwork: /^(1|true|yes|on)$/i.test(process.env.OCD_HTTP_ALLOW_PRIVATE ?? ""),
      timeoutMs: Number(process.env.OCD_HTTP_TIMEOUT ?? 30_000)
    }
  });

  process.stderr.write(`opencode-devtools-mcp: groups ${options.groups.join(", ")}\n`);
  if (options.groups.includes("http")) {
    process.stderr.write(
      `opencode-devtools-mcp: http egress enabled (allowPrivateNetwork=${options.http.allowPrivateNetwork})\n`
    );
  }

  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(
    `opencode-devtools-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
