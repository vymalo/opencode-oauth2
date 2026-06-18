import type { NeutralResult } from "@vymalo/opencode-devtools/lib";

/** An MCP tool-result content block. Devtools results are text-only. */
export type McpContent = { type: "text"; text: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Render an adapter-neutral result into MCP tool-result content. Devtools tools
 * never return images, so both `text` and `json` results map to a TextContent
 * (the neutral result's `text` is always self-sufficient).
 */
export function toMcpContent(result: NeutralResult): McpToolResult {
  return { content: [{ type: "text", text: result.text }] };
}

/** Render a thrown error as an MCP tool error result (so the model sees it). */
export function toMcpError(err: unknown): McpToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}
