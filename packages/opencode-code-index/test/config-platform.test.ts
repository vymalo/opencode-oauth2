import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ platform: "linux" as NodeJS.Platform }));

vi.mock("node:os", () => ({
  homedir: () => "/home/u",
  platform: () => state.platform
}));

import { cacheDir } from "../src/config.js";

const origXdg = process.env.XDG_CACHE_HOME;
const origLocal = process.env.LOCALAPPDATA;

afterEach(() => {
  process.env.XDG_CACHE_HOME = origXdg;
  process.env.LOCALAPPDATA = origLocal;
});

describe("cacheDir per platform", () => {
  it("uses ~/Library/Caches on macOS", () => {
    state.platform = "darwin";
    expect(cacheDir()).toContain("/Library/Caches/opencode-code-index");
  });

  it("uses XDG_CACHE_HOME (or ~/.cache) on linux", () => {
    state.platform = "linux";
    delete process.env.XDG_CACHE_HOME;
    expect(cacheDir()).toContain("/home/u/.cache/opencode-code-index");
    process.env.XDG_CACHE_HOME = "/custom/cache";
    expect(cacheDir()).toContain("/custom/cache/opencode-code-index");
  });

  it("uses LOCALAPPDATA on windows", () => {
    state.platform = "win32";
    process.env.LOCALAPPDATA = "/win/local";
    expect(cacheDir()).toContain("opencode-code-index");
    expect(cacheDir()).toContain("/win/local");
  });
});
