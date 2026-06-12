import { randomBytes } from "node:crypto";
import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { Bridge, type BridgeTransport, createBunTransport } from "./bridge.js";
import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { createBrowserTools, type SaveScreenshot } from "./tools.js";
import type { BrowserPluginOptions, ResolvedBrowserOptions } from "./types.js";

const PLUGIN_SERVICE_NAME = "opencode-browser-plugin";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 4517,
  executor: "auto",
  timeoutMs: 30_000,
  screenshotDir: ".opencode/browser"
} as const;

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface BrowserPluginFactoryOptions {
  /** Inject a logger (defaults to the OpenCode-piped logger). */
  logger?: Logger;
  /** Inject the WebSocket transport (defaults to the Bun-backed one). */
  transport?: BridgeTransport;
  /** Inject the screenshot disk-writer (tests). */
  saveScreenshot?: SaveScreenshot;
  /** Inject token generation (tests). */
  generateToken?: () => string;
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the pattern used by `@vymalo/opencode-oauth2` / `-ratelimit`.
 */
function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    fallback[level](event, fields);
    void client.app
      .log({ body: { service: PLUGIN_SERVICE_NAME, level, message: event, extra: fields } })
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

function resolveOptions(
  raw: PluginOptions | undefined,
  generateToken: () => string
): ResolvedBrowserOptions {
  const opts = (raw ?? {}) as BrowserPluginOptions;
  const token =
    typeof opts.token === "string" && opts.token.length > 0 ? opts.token : generateToken();
  return {
    enabled: opts.enabled !== false,
    host: opts.host ?? DEFAULTS.host,
    port: opts.port ?? DEFAULTS.port,
    token,
    executor: opts.executor ?? DEFAULTS.executor,
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
    screenshotDir: opts.screenshotDir ?? DEFAULTS.screenshotDir
  };
}

export function createBrowserPlugin(factoryOptions: BrowserPluginFactoryOptions = {}): Plugin {
  return async ({ client }, pluginOptions) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);
    const generateToken = factoryOptions.generateToken ?? (() => randomBytes(24).toString("hex"));

    const options = resolveOptions(pluginOptions, generateToken);
    const rawOptions = pluginOptions as BrowserPluginOptions | undefined;
    const tokenProvided = typeof rawOptions?.token === "string";
    // Only forward the executor preference when the operator set it explicitly;
    // otherwise the extension keeps its own dashboard choice.
    const executorProvided = typeof rawOptions?.executor === "string";

    if (!options.enabled) {
      logger.info("browser_plugin_disabled", {});
      return {
        config: async (config: OpenCodeConfig) => {
          currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        }
      };
    }

    const bridge = new Bridge(
      {
        host: options.host,
        port: options.port,
        token: options.token,
        timeoutMs: options.timeoutMs,
        executor: executorProvided ? options.executor : undefined
      },
      { logger, transport: factoryOptions.transport ?? createBunTransport() }
    );

    try {
      bridge.start();
      if (!tokenProvided) {
        // Auto-generated token must be visible so it can be pasted into the
        // extension. The `paste_into_extension` field name deliberately dodges
        // the logger's token-redaction filter — printing it once is the point.
        logger.info("browser_bridge_token_generated", { paste_into_extension: options.token });
      }
    } catch (err) {
      logger.error("browser_bridge_start_failed", {
        message: err instanceof Error ? err.message : String(err),
        port: options.port
      });
    }

    const tools = createBrowserTools({
      bridge,
      options,
      logger,
      saveScreenshot: factoryOptions.saveScreenshot
    });

    return {
      tool: tools,
      config: async (config: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
      }
    };
  };
}

export const OpencodeBrowserPlugin = createBrowserPlugin();

export default OpencodeBrowserPlugin;
