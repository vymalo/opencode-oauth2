export {
  createOpencodeModelsInfoPlugin,
  OpencodeModelsInfoPlugin,
  type OpenCodePluginFactoryOptions
} from "./opencode.js";

export {
  cacheKey,
  type CacheStore,
  FileCacheStore,
  isExpired,
  resolveCacheDir
} from "./cache.js";

export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  parseMetaOptions
} from "./config.js";

export { fetchOpenRouterModels, type FetchOptions } from "./fetcher.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  type Logger,
  type LogLevel
} from "./logging.js";

export {
  mapOpenRouterEntry,
  mergeIntoModel,
  type ModelMetadata
} from "./mapping.js";

export {
  type EnrichConfigInput,
  type EnrichDeps,
  enrichConfig,
  type ProviderConfigLike
} from "./plugin.js";

export type {
  CachedModelsRecord,
  FetchModelsResult,
  MetaProviderOptions,
  OpenRouterArchitecture,
  OpenRouterModality,
  OpenRouterModel,
  OpenRouterModelsResponse,
  OpenRouterPricing,
  OpenRouterTopProvider
} from "./types.js";
