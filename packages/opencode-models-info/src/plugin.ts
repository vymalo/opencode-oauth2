import { cacheKey, type CacheStore, FileCacheStore, isExpired } from "./cache.js";
import { parseMetaOptions } from "./config.js";
import { fetchOpenRouterModels } from "./fetcher.js";
import type { Logger } from "./logging.js";
import { mapOpenRouterEntry, mergeIntoModel } from "./mapping.js";
import type { CachedModelsRecord, MetaProviderOptions, OpenRouterModel } from "./types.js";

export type ProviderOptions = Record<string, unknown> | undefined;

export interface ProviderConfigLike {
  options?: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
}

export interface EnrichConfigInput {
  provider?: Record<string, ProviderConfigLike>;
}

export interface EnrichDeps {
  cache: CacheStore;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Walk every provider in the assembled OpenCode config, fetch its
 * `meta.modelsInfoUrl` (if any) — honoring the cache — and merge derived
 * metadata onto each matching model entry. Runs providers in parallel; one
 * failure never blocks others.
 */
export async function enrichConfig(
  input: EnrichConfigInput,
  deps: EnrichDeps
): Promise<void> {
  const providers = input.provider;
  if (!providers) {
    return;
  }

  await Promise.allSettled(
    Object.entries(providers).map(([providerId, providerConfig]) =>
      enrichProvider(providerId, providerConfig, deps)
    )
  );
}

async function enrichProvider(
  providerId: string,
  providerConfig: ProviderConfigLike | undefined,
  deps: EnrichDeps
): Promise<void> {
  if (!providerConfig) {
    return;
  }
  const opts = parseMetaOptions(providerConfig.options);
  if (!opts) {
    return;
  }
  const models = providerConfig.models;
  if (!models || Object.keys(models).length === 0) {
    deps.logger.debug("models_info_provider_skipped_no_models", { providerId });
    return;
  }

  const record = await loadRecord(providerId, opts, deps);
  if (!record) {
    return;
  }

  const byId = new Map<string, OpenRouterModel>(record.models.map((m) => [m.id, m]));

  let enrichedCount = 0;
  for (const [modelId, modelConfig] of Object.entries(models)) {
    const declaredId = typeof modelConfig.id === "string" ? modelConfig.id : undefined;
    const match = byId.get(modelId) ?? (declaredId ? byId.get(declaredId) : undefined);
    if (!match) {
      continue;
    }
    const derived = mapOpenRouterEntry(match);
    mergeIntoModel(modelConfig, derived);
    enrichedCount += 1;
  }

  deps.logger.info("models_info_enriched", {
    providerId,
    enrichedCount,
    totalModels: Object.keys(models).length,
    sourceModels: record.models.length
  });
}

async function loadRecord(
  providerId: string,
  opts: MetaProviderOptions,
  deps: EnrichDeps
): Promise<CachedModelsRecord | undefined> {
  const key = cacheKey(providerId, opts.modelsInfoUrl);
  const now = deps.now ? deps.now() : Date.now();
  const cached = await deps.cache.get(key);

  if (cached && !isExpired(cached, now)) {
    deps.logger.debug("models_info_cache_hit", {
      providerId,
      url: opts.modelsInfoUrl,
      ageMs: now - cached.fetchedAt
    });
    return cached;
  }

  const headers = buildFetchHeaders(opts);
  const result = await fetchOpenRouterModels({
    url: opts.modelsInfoUrl,
    headers,
    timeoutMs: opts.modelsInfoTimeoutMs,
    etag: cached?.etag,
    fetchImpl: deps.fetchImpl
  });

  if (result.status === "ok" && result.models) {
    const next: CachedModelsRecord = {
      fetchedAt: now,
      ttlSeconds: opts.modelsInfoTtlSeconds,
      etag: result.etag,
      models: result.models
    };
    await deps.cache.put(key, next);
    deps.logger.info("models_info_fetched", {
      providerId,
      url: opts.modelsInfoUrl,
      count: result.models.length
    });
    return next;
  }

  if (result.status === "not-modified" && cached) {
    const refreshed: CachedModelsRecord = { ...cached, fetchedAt: now };
    await deps.cache.put(key, refreshed);
    deps.logger.debug("models_info_not_modified", {
      providerId,
      url: opts.modelsInfoUrl
    });
    return refreshed;
  }

  if (cached) {
    deps.logger.warn("models_info_fetch_failed_using_stale", {
      providerId,
      url: opts.modelsInfoUrl,
      error: result.error,
      ageMs: now - cached.fetchedAt
    });
    return cached;
  }

  deps.logger.warn("models_info_fetch_failed_no_cache", {
    providerId,
    url: opts.modelsInfoUrl,
    error: result.error
  });
  return undefined;
}

function buildFetchHeaders(opts: MetaProviderOptions): Record<string, string> | undefined {
  return opts.modelsInfoHeaders;
}

export { FileCacheStore };
