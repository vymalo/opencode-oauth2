import { CODEC_TOOLS } from "./groups/codec.js";
import { CONVERT_TOOLS } from "./groups/convert.js";
import { CRYPTO_TOOLS } from "./groups/crypto.js";
import { DATETIME_TOOLS } from "./groups/datetime.js";
import { HTTP_TOOLS } from "./groups/http.js";
import { MATH_TOOLS } from "./groups/math.js";
import type { ToolGroup } from "./schema.js";
import type { ToolSpec } from "./tool-spec.js";

export type { ToolGroup } from "./schema.js";
export type { NeutralResult, ToolContext, ToolSpec } from "./tool-spec.js";

export const TOOL_GROUPS: readonly ToolGroup[] = [
  "math",
  "codec",
  "crypto",
  "datetime",
  "convert",
  "http"
] as const;

/**
 * Groups registered when the operator doesn't specify. The five deterministic,
 * offline groups are on; `http` performs network egress and is opt-in.
 */
export const DEFAULT_GROUPS: readonly ToolGroup[] = [
  "math",
  "codec",
  "crypto",
  "datetime",
  "convert"
] as const;

/**
 * The single source of truth for the devtools tool surface, shared by the
 * OpenCode plugin and the MCP server. Filter by `group` to gate what an agent
 * sees.
 */
export const DEVTOOLS_TOOLS: readonly ToolSpec[] = [
  ...MATH_TOOLS,
  ...CODEC_TOOLS,
  ...CRYPTO_TOOLS,
  ...DATETIME_TOOLS,
  ...CONVERT_TOOLS,
  ...HTTP_TOOLS
];

/** The catalog tools enabled for the given groups. */
export function selectTools(groups: readonly ToolGroup[]): ToolSpec[] {
  const enabled = new Set(groups);
  return DEVTOOLS_TOOLS.filter((spec) => enabled.has(spec.group));
}
