export {
  type BrowserPluginFactoryOptions,
  createBrowserPlugin,
  OpencodeBrowserPlugin
} from "./opencode.js";

export {
  Bridge,
  BridgeError,
  type BridgeDeps,
  type BridgeOptions,
  type BridgeTransport,
  type ClientConnection,
  createBunTransport,
  type TransportHandlers
} from "./bridge.js";

export { createBrowserTools, type SaveScreenshot, type ToolDeps } from "./tools.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  type Logger,
  type LogLevel
} from "./logging.js";

export {
  BROWSER_ACTIONS,
  type BrowserAction,
  type BrowserEventName,
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  type EventFrame,
  type Frame,
  type HelloFrame,
  nextId,
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ResultFrame
} from "./protocol.js";

export type {
  BrowserPluginOptions,
  ExecutorMode,
  ResolvedBrowserOptions,
  ScreenshotResult
} from "./types.js";
