import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir so the home-based fallback writes into a temp dir, never the real
// user profile. tmpdir stays real (used to make the temp dirs).
let home: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home };
});

import { readBridgeFile, writeBridgeFile } from "../src/token-file.js";

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("bridge state file location", () => {
  let xdg: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocb-home-"));
    xdg = mkdtempSync(join(tmpdir(), "ocb-xdg-"));
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(realPlatform);
    delete process.env.XDG_STATE_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  });

  it("round-trips through an absolute XDG_STATE_HOME", () => {
    process.env.XDG_STATE_HOME = xdg;
    writeBridgeFile(4517, "tok-abs");

    expect(existsSync(join(xdg, "opencode-browser", "bridge.json"))).toBe(true);
    expect(readBridgeFile()).toEqual({ port: 4517, token: "tok-abs" });
  });

  it("ignores a relative XDG_STATE_HOME and falls back to the home dir", () => {
    process.env.XDG_STATE_HOME = "relative/state";
    writeBridgeFile(4517, "tok-rel");

    // Must NOT scatter a token relative to the process cwd…
    expect(existsSync(join(process.cwd(), "relative", "state"))).toBe(false);
    // …and the home-based fallback holds the token instead.
    expect(existsSync(join(home, ".local", "state", "opencode-browser", "bridge.json"))).toBe(true);
    expect(readBridgeFile()).toEqual({ port: 4517, token: "tok-rel" });
  });

  it("ignores an empty XDG_STATE_HOME", () => {
    process.env.XDG_STATE_HOME = "";
    writeBridgeFile(4517, "tok-empty");

    expect(existsSync(join(home, ".local", "state", "opencode-browser", "bridge.json"))).toBe(true);
    expect(readBridgeFile()?.token).toBe("tok-empty");
  });
});
