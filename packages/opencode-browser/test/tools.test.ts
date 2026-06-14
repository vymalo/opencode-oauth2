import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_TOOLS } from "../src/catalog.js";
import type { Logger } from "../src/logging.js";
import { createBrowserTools, type SendFn } from "../src/tools.js";
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
    groups: ["page", "control", "debug", "interactive"],
    timeoutMs: 30_000,
    screenshotDir: ".opencode/browser",
    ...overrides
  };
}

/** Fake endpoint send() spy. */
function fakeSend(result: unknown = {}) {
  const send = vi.fn().mockResolvedValue(result) as unknown as SendFn & ReturnType<typeof vi.fn>;
  return send;
}

function ctx(worktree = "/tmp") {
  return { abort: new AbortController().signal, worktree } as unknown as Parameters<
    ReturnType<typeof createBrowserTools>["browser_open"]["execute"]
  >[1];
}

describe("tool arg schemas", () => {
  const tools = createBrowserTools({
    send: fakeSend(),
    options: baseOptions(),
    logger: noopLogger
  });

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

  it("filters tools by enabled groups", () => {
    const pageOnly = createBrowserTools({
      send: fakeSend(),
      options: baseOptions({ groups: ["page"] }),
      logger: noopLogger
    });
    const names = Object.keys(pageOnly);
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_snapshot");
    expect(names).not.toContain("browser_click"); // control group excluded
    expect(names).not.toContain("browser_open");
  });

  it("exposes every catalog tool when all groups are enabled", () => {
    const names = Object.keys(tools);
    expect(names).toHaveLength(BROWSER_TOOLS.length);
    for (const spec of BROWSER_TOOLS) {
      expect(names).toContain(spec.name);
    }
    // spot-check representative tools from each group
    expect(names).toEqual(
      expect.arrayContaining([
        "browser_open",
        "browser_click",
        "browser_back",
        "browser_hover",
        "browser_get_html",
        "browser_query",
        "browser_eval",
        "browser_console",
        "browser_cookies"
      ])
    );
  });
});

describe("tool → bridge action mapping", () => {
  it("maps browser_open to the open action (with target)", async () => {
    const send = fakeSend({ title: "Example", url: "https://example.com" });
    const tools = createBrowserTools({ send, options: baseOptions(), logger: noopLogger });
    const c = ctx();
    const res = await tools.browser_open.execute(
      { group: "research", url: "https://example.com", target: "work-chrome" },
      c
    );
    expect(send).toHaveBeenCalledWith(
      "open",
      "research",
      expect.objectContaining({ url: "https://example.com" }),
      c.abort,
      "work-chrome",
      undefined
    );
    expect(typeof res === "object" ? res.output : res).toContain("research");
  });

  it("maps browser_click target params through", async () => {
    const send = fakeSend();
    const tools = createBrowserTools({ send, options: baseOptions(), logger: noopLogger });
    await tools.browser_click.execute({ group: "g", ref: "e7" }, ctx());
    expect(send).toHaveBeenCalledWith(
      "click",
      "g",
      expect.objectContaining({ ref: "e7" }),
      expect.anything(),
      undefined,
      undefined
    );
  });

  it("returns page text directly for browser_get_text", async () => {
    const send = fakeSend({ text: "hello world" });
    const tools = createBrowserTools({ send, options: baseOptions(), logger: noopLogger });
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
    const send = fakeSend({ base64: png.toString("base64"), width: 1280, height: 800 });
    const tools = createBrowserTools({
      send,
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

describe("browser_request_feedback (interactive group)", () => {
  it("is gated behind the opt-in interactive group", () => {
    const off = createBrowserTools({
      send: fakeSend(),
      options: baseOptions({ groups: ["page", "control", "debug"] }),
      logger: noopLogger
    });
    expect(Object.keys(off)).not.toContain("browser_request_feedback");

    const on = createBrowserTools({
      send: fakeSend(),
      options: baseOptions({ groups: ["page", "control", "interactive"] }),
      logger: noopLogger
    });
    expect(Object.keys(on)).toContain("browser_request_feedback");
  });

  it("sends the request_feedback action with a long per-command timeout", async () => {
    const send = fakeSend({ responded: true, annotations: [{ kind: "confirm", value: true }] });
    const tools = createBrowserTools({
      send,
      options: baseOptions({ groups: ["interactive"] }),
      logger: noopLogger
    });
    await tools.browser_request_feedback.execute(
      { group: "g", mode: "confirm", prompt: "ok?" },
      ctx()
    );
    expect(send).toHaveBeenCalledWith(
      "request_feedback",
      "g",
      expect.objectContaining({ mode: "confirm", prompt: "ok?", timeoutMs: 120_000 }),
      expect.anything(),
      undefined,
      300_000
    );
  });

  it("clamps a user timeout to the overlay ceiling", async () => {
    const send = fakeSend({ responded: true, annotations: [] });
    const tools = createBrowserTools({
      send,
      options: baseOptions({ groups: ["interactive"] }),
      logger: noopLogger
    });
    await tools.browser_request_feedback.execute(
      { group: "g", mode: "confirm", timeoutMs: 999_999 },
      ctx()
    );
    expect(send).toHaveBeenCalledWith(
      "request_feedback",
      "g",
      expect.objectContaining({ timeoutMs: 290_000 }),
      expect.anything(),
      undefined,
      300_000
    );
  });

  it("summarizes a confirm response", async () => {
    const send = fakeSend({ responded: true, annotations: [{ kind: "confirm", value: true }] });
    const tools = createBrowserTools({
      send,
      options: baseOptions({ groups: ["interactive"] }),
      logger: noopLogger
    });
    const res = await tools.browser_request_feedback.execute(
      { group: "g", mode: "confirm" },
      ctx()
    );
    expect(typeof res === "object" ? res.output : res).toMatch(/confirmed/i);
  });

  it("reports a timeout as no response", async () => {
    const send = fakeSend({ responded: false, timedOut: true, annotations: [] });
    const tools = createBrowserTools({
      send,
      options: baseOptions({ groups: ["interactive"] }),
      logger: noopLogger
    });
    const res = await tools.browser_request_feedback.execute(
      { group: "g", mode: "confirm" },
      ctx()
    );
    expect(typeof res === "object" ? res.output : res).toMatch(/no response/i);
  });

  it("resolves a point response to its element ref in the summary", async () => {
    const send = fakeSend({
      responded: true,
      annotations: [{ kind: "point", x: 10, y: 20, ref: "e42", selector: "#x" }]
    });
    const tools = createBrowserTools({
      send,
      options: baseOptions({ groups: ["interactive"] }),
      logger: noopLogger
    });
    const res = await tools.browser_request_feedback.execute({ group: "g", mode: "point" }, ctx());
    expect(typeof res === "object" ? res.output : res).toMatch(/ref e42/);
  });
});

describe("browser_request_feedback rich modes (Phase 2)", () => {
  const interactive = (result: unknown) =>
    createBrowserTools({
      send: fakeSend(result),
      options: baseOptions({ groups: ["interactive"] }),
      logger: noopLogger
    });

  it("summarizes an element selection by ref", async () => {
    const tools = interactive({
      responded: true,
      annotations: [{ kind: "element", ref: "e9", selector: "#x", text: "Inbox" }]
    });
    const res = await tools.browser_request_feedback.execute(
      { group: "g", mode: "element" },
      ctx()
    );
    expect(typeof res === "object" ? res.output : res).toMatch(/selected ref e9/);
  });

  it("summarizes a region with covered refs", async () => {
    const tools = interactive({
      responded: true,
      annotations: [
        { kind: "region", rect: { x: 0, y: 0, width: 120, height: 60 }, refs: ["e1", "e2"] }
      ]
    });
    const res = await tools.browser_request_feedback.execute({ group: "g", mode: "region" }, ctx());
    expect(typeof res === "object" ? res.output : res).toMatch(/120×60 region covering e1, e2/);
  });

  it("includes a comment note in the summary", async () => {
    const tools = interactive({
      responded: true,
      annotations: [{ kind: "point", x: 1, y: 2, ref: "e3", text: "this label is wrong" }]
    });
    const res = await tools.browser_request_feedback.execute(
      { group: "g", mode: "comment" },
      ctx()
    );
    expect(typeof res === "object" ? res.output : res).toMatch(/this label is wrong/);
  });

  it("surfaces an overlay error distinctly from a timeout", async () => {
    const tools = interactive({ responded: false, error: "page blocked the overlay" });
    const res = await tools.browser_request_feedback.execute({ group: "g", mode: "point" }, ctx());
    const output = typeof res === "object" ? res.output : res;
    expect(output).toMatch(/page blocked the overlay/);
    expect(output).toMatch(/screenshot\/snapshot/);
  });
});
