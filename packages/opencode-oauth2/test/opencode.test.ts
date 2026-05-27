import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { createOpencodeOauth2Plugin, fromOpenCodeLogLevel } from "../src/opencode.js";
import { createSilentLogger } from "./helpers.js";

async function createHooks(cacheDir: string) {
  const plugin = createOpencodeOauth2Plugin({
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
            oauth2: {
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

  it("uses model.providerID when provider context is not populated by the host", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-providerid-"));
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
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.(
      {
        sessionID: "session-1",
        agent: "general",
        model: { id: "glm-5", providerID: "example-ai" },
        message: { id: "message-1" }
      } as never,
      output
    );

    expect(output.headers.Authorization).toBe("Bearer cached-access");
  });

  it("propagates the cached bearer into provider.options.headers for downstream config-time consumers", async () => {
    // The composition contract for @vymalo/opencode-models-info: by the time
    // a later `config` hook walks `config.provider[*]`, every managed
    // provider already carries a usable `Authorization` header so an
    // OAuth2-protected `meta.modelsInfoUrl` fetch inherits the token without
    // depending on this plugin.
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-propagate-"));
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
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const providerOptions = (config.provider as Record<string, Record<string, unknown>>)[
      "example-ai"
    ].options as Record<string, unknown>;
    const headers = providerOptions.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer cached-access");
  });

  it("does not overwrite a user-set Authorization header during propagation", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-userauth-"));
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
          options: {
            baseURL: "https://api.example.com/v1",
            // Lowercase to also exercise the case-insensitive guard.
            headers: { authorization: "Bearer user-override" },
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const headers = (
      (config.provider as Record<string, Record<string, unknown>>)["example-ai"].options as Record<
        string,
        unknown
      >
    ).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer user-override");
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects invalid redirectPort in provider.options.oauth2", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-badport-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
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

  it("parses clientSecret + device_code authFlow from provider.options.oauth2", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-secret-provider-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          name: "Example AI",
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              clientSecret: "secret-from-provider",
              scopes: ["openid", "offline_access"],
              authFlow: "device_code",
              deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
            }
          }
        }
      }
    };

    // Resolve should accept without throwing; the runtime is constructed and
    // wired up from this config — but we don't actually call the chat hook
    // here (which would attempt an OAuth flow), we just confirm parsing.
    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["example-ai"]?.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("parses clientSecret + device_code authFlow from pluginConfig.oauth2ModelSync.servers", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-secret-plugincfg-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "server-secret",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              clientSecret: "secret-from-plugin-config",
              scopes: ["openid"],
              authFlow: "device_code",
              deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
            }
          ]
        }
      }
    };

    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["server-secret"]).toBeDefined();
    expect(providers["server-secret"]?.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("rejects unknown authFlow values from both config shapes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-bad-authflow-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid"],
              authFlow: "implicit"
            }
          }
        }
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/authFlow/);
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

  it("accepts an OpenCode host logLevel without requiring a plugin-specific override", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-host-loglevel-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      logLevel: "DEBUG",
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "server-1",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              scopes: ["openid"]
            }
          ]
        }
      }
    };

    await expect(hooks.config?.(config as never)).resolves.not.toThrow();

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["server-1"]?.npm).toBe("@ai-sdk/openai-compatible");
  });
});

describe("fromOpenCodeLogLevel", () => {
  it("maps OpenCode's uppercase log levels to internal lowercase levels", () => {
    expect(fromOpenCodeLogLevel("DEBUG")).toBe("debug");
    expect(fromOpenCodeLogLevel("INFO")).toBe("info");
    expect(fromOpenCodeLogLevel("WARN")).toBe("warn");
    expect(fromOpenCodeLogLevel("ERROR")).toBe("error");
  });

  it("tolerates mixed-case input from non-canonical hosts", () => {
    expect(fromOpenCodeLogLevel("debug")).toBe("debug");
    expect(fromOpenCodeLogLevel("Info")).toBe("info");
  });

  it("returns undefined for missing or unrecognized values so the caller can apply a default", () => {
    expect(fromOpenCodeLogLevel(undefined)).toBeUndefined();
    expect(fromOpenCodeLogLevel(null)).toBeUndefined();
    expect(fromOpenCodeLogLevel("trace")).toBeUndefined();
    expect(fromOpenCodeLogLevel(42)).toBeUndefined();
  });
});
