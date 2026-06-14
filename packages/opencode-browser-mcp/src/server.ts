import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  BROWSER_TOOLS,
  type NeutralResult,
  type SendFn,
  toJsonSchema,
  type ToolGroup,
  type ToolSpec
} from "@vymalo/opencode-browser/lib";

import { type McpToolResult, toMcpContent, toMcpError } from "./render.js";

/** The catalog tools enabled for the given groups. */
export function selectTools(groups: ToolGroup[]): ToolSpec[] {
  const enabled = new Set(groups);
  return BROWSER_TOOLS.filter((spec) => enabled.has(spec.group));
}

/**
 * Build an MCP server that exposes the group-filtered browser_* catalog and
 * routes tools/call through the bridge endpoint to the connected extension.
 */
export function createMcpServer(send: SendFn, groups: ToolGroup[]): Server {
  const specs = selectTools(groups);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  const server = new Server(
    { name: "opencode-browser", version: "0.7.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: toJsonSchema(spec.input) as { type: "object" }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    // McpToolResult is a structural subset of CallToolResult (text/image blocks).
    const render = (r: McpToolResult): CallToolResult => r as CallToolResult;
    const spec = byName.get(request.params.name);
    if (!spec) {
      return render(toMcpError(new Error(`unknown tool: ${request.params.name}`)));
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const params = spec.params ? spec.params(args) : args;
      const group = typeof args.group === "string" ? args.group : "";
      const target = typeof args.target === "string" ? args.target : undefined;
      const data = await send(spec.action, group, params, undefined, target, spec.timeoutMs);
      const result: NeutralResult = spec.result
        ? spec.result(data, args)
        : { kind: "text", text: `${spec.name} ok` };
      return render(toMcpContent(result));
    } catch (err) {
      return render(toMcpError(err));
    }
  });

  return server;
}
