import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bridge } from "../src/bridge.js";
import type { Logger } from "../src/logging.js";
import { createBrowserTools } from "../src/tools.js";
import type { ResolvedBrowserOptions } from "../src/types.js";

const z = tool.schema;
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function baseOptions(overrides: Partial<ResolvedBrowserOptions> = {}): ResolvedBrowserOptions {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 4517,
    token: "secret",
    executor: "auto",
    timeoutMs: 30_000,
    screenshotDir: ".opencode/browser",
    ...overrides
  };
}

/** Fake bridge whose send() is a spy. */
function fakeBridge(result: unknown = {}) {
  const send = vi.fn().mockResolvedValue(result);
  return { bridge: { send } as unknown as Bridge, send };
}

function ctx(worktree = "/tmp") {
  return { abort: new AbortController().signal, worktree } as unknown as Parameters<
    ReturnType<typeof createBrowserTools>["browser_open"]["execute"]
  >[1];
}

describe("tool arg schemas", () => {
  const { bridge } = fakeBridge();
  const tools = createBrowserTools({ bridge, options: baseOptions(), logger: noopLogger });

  it("requires group on browser_open", () => {
    const schema = z.object(tools.browser_open.args);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ group: "g" }).success).toBe(true);
  });

  it("rejects an invalid mouse button on browser_click", () => {
    const schema = z.object(tools.browser_click.args);
    expect(schema.safeParse({ group: "g", button: "sideways" }).success).toBe(false);
    expect(schema.safeParse({ group: "g", button: "right" }).success).toBe(true);
  });

  it("validates the fields array on browser_fill", () => {
    const schema = z.object(tools.browser_fill.args);
    expect(schema.safeParse({ group: "g", fields: [{ value: "x" }] }).success).toBe(true);
    expect(schema.safeParse({ group: "g", fields: [{ selector: "#a" }] }).success).toBe(false);
  });

  it("exposes the full action set", () => {
    expect(Object.keys(tools).sort()).toEqual(
      [
        "browser_click",
        "browser_close",
        "browser_double_click",
        "browser_fill",
        "browser_get_text",
        "browser_navigate",
        "browser_open",
        "browser_press_key",
        "browser_screenshot",
        "browser_scroll",
        "browser_select",
        "browser_snapshot",
        "browser_tabs",
        "browser_type",
        "browser_wait"
      ].sort()
    );
  });
});

describe("tool → bridge action mapping", () => {
  it("maps browser_open to the open action", async () => {
    const { bridge, send } = fakeBridge({ title: "Example", url: "https://example.com" });
    const tools = createBrowserTools({ bridge, options: baseOptions(), logger: noopLogger });
    const c = ctx();
    const res = await tools.browser_open.execute(
      { group: "research", url: "https://example.com" },
      c
    );
    expect(send).toHaveBeenCalledWith(
      "open",
      "research",
      { url: "https://example.com", focus: undefined },
      c.abort
    );
    expect(typeof res === "object" ? res.output : res).toContain("research");
  });

  it("maps browser_click target params through", async () => {
    const { bridge, send } = fakeBridge();
    const tools = createBrowserTools({ bridge, options: baseOptions(), logger: noopLogger });
    await tools.browser_click.execute({ group: "g", ref: "e7" }, ctx());
    expect(send).toHaveBeenCalledWith(
      "click",
      "g",
      expect.objectContaining({ ref: "e7" }),
      expect.anything()
    );
  });

  it("returns page text directly for browser_get_text", async () => {
    const { bridge } = fakeBridge({ text: "hello world" });
    const tools = createBrowserTools({ bridge, options: baseOptions(), logger: noopLogger });
    const res = await tools.browser_get_text.execute({ group: "g" }, ctx());
    expect(res).toBe("hello world");
  });
});

describe("browser_screenshot disk write", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    tmpDirs.length = 0;
  });

  it("writes the PNG and returns its path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocb-shot-"));
    tmpDirs.push(dir);
    const png = Buffer.from("fake-png-bytes");
    const { bridge } = fakeBridge({ base64: png.toString("base64"), width: 1280, height: 800 });
    const tools = createBrowserTools({
      bridge,
      // absolute screenshotDir → written there directly
      options: baseOptions({ screenshotDir: dir }),
      logger: noopLogger
    });

    const res = await tools.browser_screenshot.execute({ group: "my group" }, ctx(dir));
    const output = typeof res === "object" ? res.output : res;
    expect(output).toMatch(/1280×800/);

    // group "my group" is slugified to "my-group"
    const files = await readdir(join(dir, "my-group"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);
    const written = await readFile(join(dir, "my-group", files[0]));
    expect(written.equals(png)).toBe(true);
  });
});
