import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildContext,
  type NeutralResult,
  selectTools,
  toJsonSchema,
  type ToolContext,
  type ToolGroup,
  type ResolvedDevtoolsOptions
} from "@vymalo/opencode-devtools/lib";

import { type McpToolResult, toMcpContent, toMcpError } from "./render.js";

export { selectTools };

export interface McpServerDeps {
  /** Inject the execution context (clock / randomness / fetch) for tests. */
  context?: Partial<Omit<ToolContext, "options">>;
}

/**
 * Build an MCP server that exposes the group-filtered devtools catalog and runs
 * each tool's handler locally (no bridge — these are pure compute tools).
 */
export function createMcpServer(
  options: ResolvedDevtoolsOptions,
  deps: McpServerDeps = {}
): Server {
  const specs = selectTools(options.groups);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const ctx = buildContext(options, deps.context);

  const server = new Server(
    { name: "opencode-devtools", version: "0.9.0" },
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
    const render = (r: McpToolResult): CallToolResult => r as CallToolResult;
    const spec = byName.get(request.params.name);
    if (!spec) {
      return render(toMcpError(new Error(`unknown tool: ${request.params.name}`)));
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result: NeutralResult = await spec.handler(args, ctx);
      return render(toMcpContent(result));
    } catch (err) {
      return render(toMcpError(err));
    }
  });

  return server;
}

/** Selected group ids from a comma-separated env string, falling back to defaults. */
export function groupsFromEnv(
  raw: string | undefined,
  all: readonly ToolGroup[],
  fallback: readonly ToolGroup[]
): ToolGroup[] {
  if (!raw) {
    return [...fallback];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((g): g is ToolGroup => all.includes(g as ToolGroup));
  return parts.length > 0 ? parts : [...fallback];
}
