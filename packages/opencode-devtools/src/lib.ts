export {
  createDevtoolsPlugin,
  type DevtoolsPluginFactoryOptions,
  OpencodeDevtoolsPlugin,
  resolveOptions
} from "./opencode.js";

export {
  DEFAULT_GROUPS,
  DEVTOOLS_TOOLS,
  type NeutralResult,
  selectTools,
  TOOL_GROUPS,
  type ToolContext,
  type ToolGroup,
  type ToolSpec
} from "./catalog.js";

export { buildContext, createDevtoolsTools, type ToolDeps } from "./tools.js";

export { type Field, type JsonInput, type JsonSchema, toJsonSchema } from "./schema.js";

export { json, optBool, optString, reqNumber, reqString, text } from "./tool-spec.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  type Logger,
  type LogLevel
} from "./logging.js";

export type {
  DevtoolsPluginOptions,
  HttpOptions,
  ResolvedDevtoolsOptions
} from "./types.js";
