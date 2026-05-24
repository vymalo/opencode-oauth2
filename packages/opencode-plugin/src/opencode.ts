import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import type { OAuth2ModelSyncConfigInput, OAuthServerConfigInput } from "./config.js";
import { createJsonConsoleLogger, type LogFields, type Logger } from "./logging.js";
import { OAuth2ModelSyncPlugin } from "./plugin.js";

const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const OAUTH_OPTIONS_KEYS = ["lightbridgeOAuth2", "oauth2ModelSync"] as const;
const PLUGIN_SERVICE_NAME = "lightbridge-opencode-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];
type OpenCodeProviderMap = NonNullable<OpenCodeConfig["provider"]>;
type OpenCodeProviderConfig = OpenCodeProviderMap[string];
type OpenCodeModelConfig = NonNullable<OpenCodeProviderConfig["models"]>[string];

interface OAuthProviderExtension {
  issuer: string;
  clientId: string;
  scopes: string[];
  syncIntervalMinutes?: number;
  nameOverrides?: Record<string, string>;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  redirectPort?: number;
}

function asRedirectPort(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value < 65536
  ) {
    return value;
  }
  return undefined;
}

interface ManagedProviders {
  servers: OAuthServerConfigInput[];
}

interface RuntimeState {
  runtime?: OAuth2ModelSyncPlugin;
  signature?: string;
  managedProviderIds: Set<string>;
}

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry));

    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === "string") {
    const normalized = value
      .split(/[\s,]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const text = asString(raw);
    if (!text) {
      continue;
    }

    normalized[key] = text;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseOAuthExtension(provider: OpenCodeProviderConfig): OAuthProviderExtension | undefined {
  const options = asRecord(provider.options);
  if (!options) {
    return undefined;
  }

  let raw: Record<string, unknown> | undefined;
  for (const key of OAUTH_OPTIONS_KEYS) {
    raw = asRecord(options[key]);
    if (raw) {
      break;
    }
  }

  if (!raw) {
    return undefined;
  }

  const issuer = asString(raw.issuer);
  const clientId = asString(raw.clientId);
  const scopes = asStringArray(raw.scopes);

  if (!issuer || !clientId || !scopes) {
    return undefined;
  }

  const syncIntervalMinutes =
    typeof raw.syncIntervalMinutes === "number" &&
    Number.isFinite(raw.syncIntervalMinutes) &&
    raw.syncIntervalMinutes > 0
      ? raw.syncIntervalMinutes
      : undefined;

  return {
    issuer,
    clientId,
    scopes,
    syncIntervalMinutes,
    nameOverrides: asStringMap(raw.nameOverrides),
    authorizationEndpoint: asString(raw.authorizationEndpoint),
    tokenEndpoint: asString(raw.tokenEndpoint),
    jwksUri: asString(raw.jwksUri),
    redirectPort: asRedirectPort(raw.redirectPort)
  };
}

function parsePluginConfigServers(config: OpenCodeConfig, logger: Logger): OAuthServerConfigInput[] {
  const root = asRecord(config);
  const pluginConfig = asRecord(root?.pluginConfig);
  const oauth2ModelSync = asRecord(pluginConfig?.oauth2ModelSync);
  const servers = oauth2ModelSync?.servers;

  if (!Array.isArray(servers)) {
    return [];
  }

  const parsed: OAuthServerConfigInput[] = [];
  for (const [index, rawServer] of servers.entries()) {
    const entry = asRecord(rawServer);
    if (!entry) {
      logger.warn("plugin_config_server_invalid", { index });
      continue;
    }

    const id = asString(entry.id);
    const name = asString(entry.name) ?? id;
    const issuer = asString(entry.issuer);
    const baseURL = asString(entry.baseURL);
    const clientId = asString(entry.clientId);
    const scopes = asStringArray(entry.scopes);

    if (!id || !issuer || !baseURL || !clientId || !scopes) {
      logger.warn("plugin_config_server_missing_fields", { index, id: id ?? "unknown" });
      continue;
    }

    const syncIntervalMinutes =
      typeof entry.syncIntervalMinutes === "number" &&
      Number.isFinite(entry.syncIntervalMinutes) &&
      entry.syncIntervalMinutes > 0
        ? entry.syncIntervalMinutes
        : undefined;

    parsed.push({
      id,
      name: name ?? id,
      issuer,
      baseURL,
      clientId,
      scopes,
      syncIntervalMinutes,
      nameOverrides: asStringMap(entry.nameOverrides),
      authorizationEndpoint: asString(entry.authorizationEndpoint),
      tokenEndpoint: asString(entry.tokenEndpoint),
      jwksUri: asString(entry.jwksUri),
      redirectPort: asRedirectPort(entry.redirectPort)
    });
  }

  return parsed;
}

function collectManagedProviders(config: OpenCodeConfig, logger: Logger): ManagedProviders {
  const providers = (config.provider ??= {});
  const byId = new Map<string, OAuthServerConfigInput>();

  for (const server of parsePluginConfigServers(config, logger)) {
    const providerConfig = (providers[server.id] ??= {});
    const providerOptions = asRecord(providerConfig.options) ?? {};

    providerConfig.npm = OPENAI_COMPATIBLE_NPM;
    providerConfig.name = asString(providerConfig.name) ?? server.name ?? server.id;
    providerConfig.options = {
      ...providerOptions,
      baseURL: server.baseURL
    };

    byId.set(server.id, {
      ...server,
      name: providerConfig.name ?? server.name ?? server.id
    });
  }

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const extension = parseOAuthExtension(providerConfig);
    if (!extension) {
      continue;
    }

    const options = asRecord(providerConfig.options) ?? {};
    const baseURL = asString(options.baseURL);
    if (!baseURL) {
      logger.warn("provider_skipped_missing_baseurl", { providerId });
      continue;
    }

    const providerName = asString(providerConfig.name) ?? providerId;
    providerConfig.npm = OPENAI_COMPATIBLE_NPM;
    providerConfig.name = providerName;
    providerConfig.options = {
      ...options,
      baseURL
    };

    byId.set(providerId, {
      id: providerId,
      name: providerName,
      issuer: extension.issuer,
      baseURL,
      clientId: extension.clientId,
      scopes: extension.scopes,
      syncIntervalMinutes: extension.syncIntervalMinutes,
      nameOverrides: extension.nameOverrides,
      authorizationEndpoint: extension.authorizationEndpoint,
      tokenEndpoint: extension.tokenEndpoint,
      jwksUri: extension.jwksUri,
      redirectPort: extension.redirectPort
    });
  }

  return { servers: [...byId.values()] };
}

function runtimeSignature(config: OAuth2ModelSyncConfigInput): string {
  const sorted = [...config.servers].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted);
}

function mergeDiscoveredModels(
  providerConfig: OpenCodeProviderConfig,
  models: Array<{ id: string; displayName: string }>
): void {
  const existingModels = (providerConfig.models ?? {}) as Record<string, OpenCodeModelConfig>;
  const merged: Record<string, OpenCodeModelConfig> = { ...existingModels };

  for (const model of models) {
    const existingModel = existingModels[model.id] ?? {};
    merged[model.id] = {
      ...existingModel,
      id: model.id,
      name: model.displayName
    };
  }

  providerConfig.models = merged;
}

function createOpenCodeLogger(client: PluginInput["client"]): Logger {
  const fallback = createJsonConsoleLogger("info");

  const write = (level: "debug" | "info" | "warn" | "error", event: string, fields?: LogFields) => {
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
        // Best-effort forwarding; console logger is the reliable fallback.
      });
  };

  return {
    debug(event, fields) {
      write("debug", event, fields);
    },
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
    error(event, fields) {
      write("error", event, fields);
    }
  };
}

export function createLightbridgeOAuth2ModelSyncPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client);

    const state: RuntimeState = {
      runtime: undefined,
      signature: undefined,
      managedProviderIds: new Set<string>()
    };

    return {
      config: async (config) => {
        const managed = collectManagedProviders(config, logger);

        if (managed.servers.length === 0) {
          state.runtime?.stop();
          state.runtime = undefined;
          state.signature = undefined;
          state.managedProviderIds = new Set<string>();
          return;
        }

        const pluginConfig: OAuth2ModelSyncConfigInput = {
          servers: managed.servers,
          cacheNamespace: "opencode-oauth2-model-sync"
        };

        const signature = runtimeSignature(pluginConfig);
        if (!state.runtime || state.signature !== signature) {
          state.runtime?.stop();

          state.runtime = new OAuth2ModelSyncPlugin(pluginConfig, {
            logger,
            fetchImpl: factoryOptions.fetchImpl,
            onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
            cacheDir: factoryOptions.cacheDir
          });

          await state.runtime.initialize();
          await state.runtime.start({ warmup: false });
          state.signature = signature;
        }

        state.managedProviderIds = new Set<string>(managed.servers.map((server) => server.id));

        const providers = (config.provider ??= {});
        for (const providerId of state.managedProviderIds) {
          const providerConfig = providers[providerId];
          if (!providerConfig) {
            continue;
          }

          const models = state.runtime.getServerModels(providerId);
          if (models.length === 0) {
            continue;
          }

          mergeDiscoveredModels(providerConfig, models);
        }
      },
      "chat.headers": async (input, output) => {
        const providerId = input.provider.info.id;
        if (!state.runtime || !state.managedProviderIds.has(providerId)) {
          return;
        }

        const token = await state.runtime.ensureAccessToken(providerId);
        output.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;

        if (state.runtime.getServerModels(providerId).length === 0) {
          void state.runtime.syncServer(providerId);
        }
      }
    };
  };
}

export const LightbridgeOAuth2ModelSyncPlugin = createLightbridgeOAuth2ModelSyncPlugin();

export default LightbridgeOAuth2ModelSyncPlugin;
