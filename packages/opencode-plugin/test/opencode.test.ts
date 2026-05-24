import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { createLightbridgeOAuth2ModelSyncPlugin } from "../src/opencode.js";
import { createSilentLogger } from "./helpers.js";

async function createHooks(cacheDir: string) {
  const plugin = createLightbridgeOAuth2ModelSyncPlugin({
    cacheDir,
    logger: createSilentLogger(),
    fetchImpl: async () => {
      throw new Error("fetch is not expected in these hook tests");
    }
  });

  return plugin({
    client: {
      app: {
        log: async () => ({ data: true })
      }
    },
    project: { id: "project-1" },
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:3000"),
    $: {} as never
  } as never);
}

describe("OpenCode plugin hooks", () => {
  it("configures provider from provider.options extension and injects auth header", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-cache-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "cached-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          name: "Example AI",
          options: {
            baseURL: "https://api.example.com/v1",
            lightbridgeOAuth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const providerConfig = (config.provider as Record<string, Record<string, unknown>>)[
      "example-ai"
    ];
    expect(providerConfig.npm).toBe("@ai-sdk/openai-compatible");

    const models = providerConfig.models as Record<string, Record<string, unknown>>;
    expect(models["glm-5"]?.name).toBe("GLM 5");

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.(
      {
        sessionID: "session-1",
        agent: "general",
        model: { id: "glm-5", providerID: "example-ai" },
        provider: {
          source: "config",
          info: { id: "example-ai" },
          options: {}
        },
        message: { id: "message-1" }
      } as never,
      output
    );

    expect(output.headers.Authorization).toBe("Bearer cached-access");
  });

  it("rejects invalid redirectPort in provider.options.lightbridgeOAuth2", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-badport-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            lightbridgeOAuth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"],
              redirectPort: 70000
            }
          }
        }
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/redirectPort/);
  });

  it("rejects invalid redirectPort in pluginConfig.oauth2ModelSync.servers", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-badport-plugincfg-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "bad-port-server",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              scopes: ["openid"],
              redirectPort: "not-a-number"
            }
          ]
        }
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/redirectPort/);
  });

  it("supports pluginConfig.oauth2ModelSync.servers and materializes provider entries", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-pluginconfig-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "server-from-plugin-config",
              name: "Server from plugin config",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          ]
        }
      }
    };

    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["server-from-plugin-config"]).toBeDefined();
    expect(providers["server-from-plugin-config"]?.npm).toBe("@ai-sdk/openai-compatible");

    const options = providers["server-from-plugin-config"]?.options as Record<string, unknown>;
    expect(options.baseURL).toBe("https://api.example.com/v1");
  });
});
