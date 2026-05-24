import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";

describe("FileCacheStore", () => {
  it("round-trips cached server state with secure file mode", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "opencode-cache-"));
    const store = new FileCacheStore(baseDir);
    await store.ensureReady();

    await store.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "access-token",
        tokenType: "Bearer",
        refreshToken: "refresh-token"
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.refreshToken).toBe("refresh-token");

    const rawContent = await readFile(join(baseDir, "example-ai.json"), "utf8");
    expect(rawContent).toContain("refresh-token");
  });

  it("keeps cached tokens without refreshToken (client_credentials grant)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "opencode-cache-no-refresh-"));
    const store = new FileCacheStore(baseDir);
    await store.ensureReady();

    await store.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }],
      token: {
        accessToken: "access-token",
        tokenType: "Bearer"
      }
    });

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.accessToken).toBe("access-token");
    expect(loaded?.token?.refreshToken).toBeUndefined();
  });

  it("drops cached tokens with malformed required fields", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "opencode-cache-invalid-"));
    const store = new FileCacheStore(baseDir);
    await store.ensureReady();

    await store.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }],
      token: {
        accessToken: "token",
        tokenType: "Bearer",
        refreshToken: "refresh-token"
      }
    });

    const filePath = join(baseDir, "example-ai.json");
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete (persisted.token as Record<string, unknown>).accessToken;

    await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token).toBeUndefined();
  });
});
