import { FileCacheStore, resolveCacheDir } from "./cache.js";
import { type OAuth2ModelSyncConfigInput, validateConfig } from "./config.js";
import { createJsonConsoleLogger, type Logger } from "./logging.js";
import { fetchModels } from "./model-discovery.js";
import { diffModels, normalizeModelList } from "./model-normalization.js";
import { OAuthClient } from "./oauth/client.js";
import { startScheduler, type SchedulerHandle } from "./scheduler.js";
import type { CachedServerState, NormalizedModel, ServerSnapshot, TokenSet } from "./types.js";

interface ServerRuntime {
  state: CachedServerState;
  scheduler?: SchedulerHandle;
}

export interface PluginOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
}

export class OAuth2ModelSyncPlugin {
  private readonly logger: Logger;
  private readonly config;
  private readonly cacheStore: FileCacheStore;
  private readonly runtimeByServer = new Map<string, ServerRuntime>();

  constructor(
    private readonly configInput: OAuth2ModelSyncConfigInput,
    private readonly options: PluginOptions = {}
  ) {
    this.config = validateConfig(this.configInput);
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.cacheStore = new FileCacheStore(
      options.cacheDir ?? resolveCacheDir(this.config.cacheNamespace)
    );
  }

  async initialize(): Promise<void> {
    await this.cacheStore.ensureReady();

    for (const server of this.config.servers) {
      const cached = await this.cacheStore.loadServerState(server.id);
      const initialState: CachedServerState =
        cached ?? {
          serverId: server.id,
          updatedAt: Date.now(),
          models: [],
          rawModels: []
        };

      this.runtimeByServer.set(server.id, { state: initialState });
    }

    this.logger.info("plugin_initialized", {
      serverCount: this.config.servers.length
    });
  }

  async start(): Promise<void> {
    await this.initialize();

    for (const server of this.config.servers) {
      try {
        await this.syncServer(server.id);
      } catch (error) {
        this.logger.warn("sync_startup_failed", {
          serverId: server.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      const handle = startScheduler({
        intervalMs: Math.round(server.syncIntervalMinutes * 60_000),
        logger: this.logger,
        taskName: `sync:${server.id}`,
        run: async () => {
          await this.syncServer(server.id);
        }
      });

      const runtime = this.runtimeByServer.get(server.id);
      if (runtime) {
        runtime.scheduler = handle;
      }
    }
  }

  stop(): void {
    for (const runtime of this.runtimeByServer.values()) {
      runtime.scheduler?.stop();
    }
  }

  async syncAll(): Promise<ServerSnapshot[]> {
    const snapshots: ServerSnapshot[] = [];
    for (const server of this.config.servers) {
      snapshots.push(await this.syncServer(server.id));
    }
    return snapshots;
  }

  async syncServer(serverId: string): Promise<ServerSnapshot> {
    const server = this.config.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`unknown server id: ${serverId}`);
    }

    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    this.logger.info("sync_start", { serverId });
    const oauth = new OAuthClient(server, {
      fetchImpl: this.options.fetchImpl,
      logger: this.logger,
      timeoutMs: this.config.httpTimeoutMs,
      onAuthorizationUrl: this.options.onAuthorizationUrl
    });

    const previousState = runtime.state;

    try {
      const token = await oauth.ensureToken(previousState.token);
      const rawModels = await fetchModels(server.baseURL, token, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.config.httpTimeoutMs,
        logger: this.logger
      });

      const normalizedModels = normalizeModelList(rawModels, server.nameOverrides);
      const diff = diffModels(previousState.models, normalizedModels);

      const nextState: CachedServerState = {
        ...previousState,
        updatedAt: Date.now(),
        lastSyncAt: Date.now(),
        token,
        rawModels,
        models: normalizedModels
      };

      await this.cacheStore.saveServerState(nextState);
      runtime.state = nextState;

      this.logger.info("sync_success", {
        serverId,
        modelCount: normalizedModels.length,
        added: diff.added.length,
        removed: diff.removed.length,
        renamed: diff.renamed.length
      });

      return {
        serverId,
        models: normalizedModels,
        lastSyncAt: nextState.lastSyncAt
      };
    } catch (error) {
      this.logger.error("sync_failed", {
        serverId,
        error: error instanceof Error ? error.message : String(error)
      });

      // Keep last-known-good state by not mutating runtime state.
      return {
        serverId,
        models: previousState.models,
        lastSyncAt: previousState.lastSyncAt
      };
    }
  }

  async ensureServerReady(serverId: string): Promise<ServerSnapshot> {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    if (!runtime.state.lastSyncAt || runtime.state.models.length === 0) {
      return this.syncServer(serverId);
    }

    return {
      serverId,
      models: runtime.state.models,
      lastSyncAt: runtime.state.lastSyncAt
    };
  }

  getServerModels(serverId: string): NormalizedModel[] {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    return [...runtime.state.models];
  }

  getProviderModelMap(serverId: string): Record<string, { name: string }> {
    const models = this.getServerModels(serverId);
    return Object.fromEntries(models.map((model) => [model.id, { name: model.displayName }]));
  }

  getCachedToken(serverId: string): TokenSet | undefined {
    return this.runtimeByServer.get(serverId)?.state.token;
  }
}
