import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_GROUPS,
  resolveOptions,
  type ResolvedDevtoolsOptions,
  type ToolContext,
  TOOL_GROUPS
} from "@vymalo/opencode-devtools/lib";
import { describe, expect, it } from "vitest";

import { createMcpServer, groupsFromEnv, selectTools } from "../src/server.js";

async function connect(
  options: ResolvedDevtoolsOptions,
  context?: Partial<Omit<ToolContext, "options">>
) {
  const server = createMcpServer(options, { context });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("createMcpServer", () => {
  it("lists only the enabled groups' tools with JSON-Schema inputs", async () => {
    const client = await connect(resolveOptions({ groups: ["math", "codec"] }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("math_eval");
    expect(names).toContain("codec_base64");
    expect(names.some((n) => n.startsWith("http_"))).toBe(false);
    expect(tools.find((t) => t.name === "math_eval")?.inputSchema.type).toBe("object");
  });

  it("runs a tool handler locally and renders text", async () => {
    const client = await connect(resolveOptions({ groups: ["math"] }));
    const res = (await client.callTool({
      name: "math_eval",
      arguments: { expression: "6 * 7" }
    })) as CallToolResult;
    expect(res.content[0]).toMatchObject({ type: "text", text: "42" });
    expect(res.isError).toBeFalsy();
  });

  it("threads the injected context into handlers", async () => {
    const client = await connect(resolveOptions({ groups: ["crypto"] }), {
      randomBytes: (n: number) => Buffer.alloc(n, 0)
    });
    const res = (await client.callTool({
      name: "crypto_random",
      arguments: { bytes: 4 }
    })) as CallToolResult;
    expect(res.content[0]).toMatchObject({ text: "00000000" });
  });

  it("returns an MCP error for an unknown tool", async () => {
    const client = await connect(resolveOptions({ groups: ["math"] }));
    const res = (await client.callTool({ name: "nope", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("unknown tool");
  });

  it("surfaces a handler error as an MCP error result", async () => {
    const client = await connect(resolveOptions({ groups: ["math"] }));
    const res = (await client.callTool({
      name: "math_eval",
      arguments: {}
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("selectTools", () => {
  it("filters the catalog by group", () => {
    expect(selectTools(["http"]).map((t) => t.name)).toEqual(["http_request", "http_graphql"]);
  });
});

describe("groupsFromEnv", () => {
  it("parses a comma list and drops invalid groups", () => {
    expect(groupsFromEnv("math, http , bogus", TOOL_GROUPS, DEFAULT_GROUPS)).toEqual([
      "math",
      "http"
    ]);
  });

  it("falls back to defaults for empty/undefined", () => {
    expect(groupsFromEnv(undefined, TOOL_GROUPS, DEFAULT_GROUPS)).toEqual([...DEFAULT_GROUPS]);
    expect(groupsFromEnv("nonsense", TOOL_GROUPS, DEFAULT_GROUPS)).toEqual([...DEFAULT_GROUPS]);
  });
});
