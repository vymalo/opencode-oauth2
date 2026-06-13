import type { NeutralResult } from "@vymalo/opencode-browser/lib";

/** An MCP tool-result content block (text or image). */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Render an adapter-neutral result into MCP tool-result content. Unlike the
 * OpenCode adapter (text-only, screenshots to disk), MCP can return the image
 * inline — so a screenshot comes straight back as an ImageContent block.
 */
export function toMcpContent(result: NeutralResult): McpToolResult {
  if (result.kind === "image") {
    return {
      content: [
        { type: "image", data: result.base64, mimeType: result.mimeType },
        {
          type: "text",
          text: result.partial
            ? `${result.text} (viewport only — full-page capture unsupported by this executor)`
            : result.text
        }
      ]
    };
  }
  return { content: [{ type: "text", text: result.text }] };
}

/** Render a thrown error as an MCP tool error result (so the model sees it). */
export function toMcpError(err: unknown): McpToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}
