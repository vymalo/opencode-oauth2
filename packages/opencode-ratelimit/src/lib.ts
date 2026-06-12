export {
  createOpencodeRatelimitPlugin,
  OpencodeRatelimitPlugin,
  type OpenCodePluginFactoryOptions
} from "./opencode.js";

export {
  DEFAULT_HEADER_PREFIX,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_SCOPE,
  parseRateLimitOptions,
  selectTier
} from "./config.js";

export { parseRateLimit } from "./headers.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  type Logger,
  type LogLevel
} from "./logging.js";

export {
  createProviderState,
  DEFAULT_BACKOFF_MS,
  type InstallConfigInput,
  installRateLimiter,
  makeRateLimitFetch,
  type ProviderConfigLike,
  type ProviderRateState,
  type RateLimitDeps,
  type RateStateStore
} from "./plugin.js";

export type {
  RateLimitAction,
  RateLimitOptions,
  RateLimitScope,
  RateLimitSnapshot,
  RateLimitTier
} from "./types.js";
