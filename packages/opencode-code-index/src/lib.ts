// Public library API for embedders (resolved via the "./lib" export). Unlike
// index.ts (which OpenCode inspects), this is the place to expose utilities.

export { createCodeIndexPlugin, type CodeIndexFactoryOptions } from "./opencode.js";
export { CodeIndexStore } from "./store.js";
export { GitRepo, makeGitRunner, type GitRunner } from "./git.js";
export { indexRepo, type IndexOptions, type IndexResult } from "./indexer.js";
export { extractFromSource, grammarForExtension, SUPPORTED_EXTENSIONS } from "./extract.js";
export { createCodeIndexTools, type ToolDeps, type OpenStore, type MakeRepo } from "./tools.js";
export { resolveOptions, defaultDbPath, cacheDir } from "./config.js";
export {
  createJsonConsoleLogger,
  fromOpenCodeLogLevel,
  type Logger,
  type LogLevel,
  type LogFields
} from "./logging.js";
export type * from "./types.js";
