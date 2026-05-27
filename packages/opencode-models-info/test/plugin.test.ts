import { describe, expect, it, vi } from "vitest";

import type { CacheStore } from "../src/cache.js";
import type { Logger } from "../src/logging.js";
import { enrichConfig, type EnrichConfigInput, type ProviderConfigLike } from "../src/plugin.js";
import type { CachedModelsRecord, OpenRouterModel } from "../src/types.js";

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function memoryCache(seed: Map<string, CachedModelsRecord> = new Map()): CacheStore {
  return {
    get: async (key) => seed.get(key),
    put: async (key, record) => void seed.set(key, record)
  };
}

function getModel(
  config: EnrichConfigInput,
  providerId: string,
  modelId: string
): Record<string, unknown> {
  const provider = config.provider?.[providerId];
  if (!provider) {
    throw new Error(`provider ${providerId} missing`);
  }
  const model = provider.models?.[modelId];
  if (!model) {
    throw new Error(`model ${providerId}.${modelId} missing`);
  }
  return model;
}

function withProvider(providerId: string, provider: ProviderConfigLike): EnrichConfigInput {
  return { provider: { [providerId]: provider } };
}

const openRouterEntry: OpenRouterModel = {
  id: "model-a",
  name: "Model A",
  context_length: 128_000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  top_provider: { max_completion_tokens: 4096 },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "temperature"]
};

describe("enrichConfig", () => {
  it("skips providers without meta.modelsInfoUrl", async () => {
    const config = withProvider("bare", {
      options: { baseURL: "https://x.test" },
      models: { "model-a": {} }
    });
    const fetchImpl = vi.fn();
    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getModel(config, "bare", "model-a")).toEqual({});
  });

  it("fetches once, caches, and merges metadata onto matching models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [openRouterEntry] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: "v1" }
      })
    );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "/models/info" }
      },
      models: { "model-a": {}, unmatched: { name: "Untouched" } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://x.test/v1/models/info");

    const enriched = getModel(config, "custom", "model-a");
    expect(enriched.limit).toEqual({ context: 128_000, output: 4096 });
    expect(enriched.cost).toEqual({ input: 3, output: 15 });
    expect(enriched.tool_call).toBe(true);
    expect(enriched.attachment).toBe(true);
    expect(enriched.name).toBe("Model A");

    expect(getModel(config, "custom", "unmatched").name).toBe("Untouched");
  });

  it("does not refetch when a non-expired cache entry exists", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const fetchImpl = vi.fn();
    const config = withProvider("custom", {
      options: { baseURL: "https://x.test", meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    const { cacheKey } = await import("../src/cache.js");
    seed.set(cacheKey("custom", "https://x.test/m"), {
      fetchedAt: 0,
      ttlSeconds: 3600,
      models: [openRouterEntry]
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1000
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getModel(config, "custom", "model-a").cost).toEqual({ input: 3, output: 15 });
  });

  it("serves stale on fetch failure when a previous cache entry exists", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const { cacheKey } = await import("../src/cache.js");
    seed.set(cacheKey("custom", "https://x.test/m"), {
      fetchedAt: 0,
      ttlSeconds: 1,
      etag: "v1",
      models: [openRouterEntry]
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const logger = silentLogger();
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000
    });

    expect(getModel(config, "custom", "model-a").cost).toEqual({ input: 3, output: 15 });
    expect(logger.warn).toHaveBeenCalledWith(
      "models_info_fetch_failed_using_stale",
      expect.objectContaining({ providerId: "custom" })
    );
  });

  it("respects 304 Not Modified by reusing cached models and refreshing fetchedAt", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const { cacheKey } = await import("../src/cache.js");
    const key = cacheKey("custom", "https://x.test/m");
    seed.set(key, {
      fetchedAt: 0,
      ttlSeconds: 1,
      etag: "v1",
      models: [openRouterEntry]
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 9_000_000
    });

    expect(getModel(config, "custom", "model-a").limit).toEqual({
      context: 128_000,
      output: 4096
    });
    expect(seed.get(key)?.fetchedAt).toBe(9_000_000);
  });
});
