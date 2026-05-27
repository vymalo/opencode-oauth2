import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import { type CacheStore, FileCacheStore } from "./cache.js";
import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { type EnrichConfigInput, enrichConfig } from "./plugin.js";

const PLUGIN_SERVICE_NAME = "opencode-models-info-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  cache?: CacheStore;
  cacheDir?: string;
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the pattern used by `@vymalo/opencode-oauth2`.
 */
function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    fallback[level](event, fields);
    void client.app
      .log({
        body: {
          service: PLUGIN_SERVICE_NAME,
          level,
          message: event,
          extra: fields
        }
      })
      .catch(() => {
        /* best-effort */
      });
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

export function createOpencodeModelsInfoPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);
    const cache = factoryOptions.cache ?? new FileCacheStore(factoryOptions.cacheDir);

    return {
      config: async (config: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        await enrichConfig(config as EnrichConfigInput, {
          cache,
          logger,
          fetchImpl: factoryOptions.fetchImpl
        });
      }
    };
  };
}

export const OpencodeModelsInfoPlugin = createOpencodeModelsInfoPlugin();

export default OpencodeModelsInfoPlugin;
