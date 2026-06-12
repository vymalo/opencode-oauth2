import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type { Bridge } from "./bridge.js";
import type { Logger } from "./logging.js";
import type { ResolvedBrowserOptions, ScreenshotResult } from "./types.js";

const z = tool.schema;

/** Where the screenshot tool gets its disk-write behavior; swappable in tests. */
export type SaveScreenshot = (input: {
  group: string;
  worktree: string;
  shot: ScreenshotResult;
}) => Promise<string>;

export interface ToolDeps {
  bridge: Bridge;
  options: ResolvedBrowserOptions;
  logger: Logger;
  saveScreenshot?: SaveScreenshot;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function describeTarget(args: { ref?: string; selector?: string; x?: number; y?: number }): string {
  if (args.ref) {
    return `ref ${args.ref}`;
  }
  if (args.selector) {
    return `selector ${args.selector}`;
  }
  if (typeof args.x === "number" && typeof args.y === "number") {
    return `(${args.x}, ${args.y})`;
  }
  return "element";
}

/**
 * Replace anything that isn't filesystem-friendly so a group name is path-safe.
 * Dots are intentionally NOT allowed — otherwise a group like `..` or `a/../b`
 * could traverse out of the screenshot directory.
 */
function slugifyGroup(group: string): string {
  const slug = group.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "default";
}

/** Build the real disk-writer bound to the resolved screenshot directory. */
function makeSaveScreenshot(options: ResolvedBrowserOptions): SaveScreenshot {
  return async ({ group, worktree, shot }) => {
    const base = isAbsolute(options.screenshotDir)
      ? options.screenshotDir
      : join(worktree, options.screenshotDir);
    const dir = join(base, slugifyGroup(group));
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const finalPath = join(dir, `${stamp}.png`);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, Buffer.from(shot.base64, "base64"), { mode: 0o600 });
    await rename(tmpPath, finalPath);
    return finalPath;
  };
}

/**
 * Build the full `browser_*` tool map registered under `Hooks.tool`. Every tool
 * is a thin adapter: validate args (zod), forward to the bridge as a command,
 * shape the extension's reply into a ToolResult.
 */
export function createBrowserTools(deps: ToolDeps): Record<string, ToolDefinition> {
  const { bridge } = deps;
  const saveScreenshot = deps.saveScreenshot ?? makeSaveScreenshot(deps.options);

  const group = z
    .string()
    .describe("Named tab group the action targets. Created on first browser_open.");

  return {
    browser_open: tool({
      description:
        "Open a new browser tab inside a named tab group (creates the group if it doesn't exist yet). Returns the tab id, final URL and page title.",
      args: {
        group,
        url: z.string().optional().describe("URL to load. Omit to open a blank tab."),
        focus: z.boolean().optional().describe("Bring the tab to the foreground (default true).")
      },
      async execute(args, ctx) {
        const data = asRecord(
          await bridge.send("open", args.group, { url: args.url, focus: args.focus }, ctx.abort)
        );
        const title = data.title ?? "(untitled)";
        const url = data.url ?? args.url ?? "about:blank";
        return {
          output: `Opened tab in group "${args.group}": ${title} — ${url}`,
          metadata: data
        };
      }
    }),

    browser_navigate: tool({
      description: "Navigate an existing tab in the group to a new URL.",
      args: {
        group,
        url: z.string().describe("URL to navigate to."),
        tabId: z
          .number()
          .optional()
          .describe("Specific tab id; defaults to the group's active tab.")
      },
      async execute(args, ctx) {
        const data = asRecord(
          await bridge.send("navigate", args.group, { url: args.url, tabId: args.tabId }, ctx.abort)
        );
        return {
          output: `Navigated to ${data.url ?? args.url} (${data.title ?? ""})`.trim(),
          metadata: data
        };
      }
    }),

    browser_click: tool({
      description:
        "Click an element. Target it by `ref` (from browser_snapshot, most reliable), by CSS `selector`, or by absolute `x`/`y` coordinates.",
      args: {
        group,
        ref: z.string().optional().describe("Element ref from a prior browser_snapshot."),
        selector: z.string().optional().describe("CSS selector."),
        x: z.number().optional().describe("Absolute x coordinate (with y)."),
        y: z.number().optional().describe("Absolute y coordinate (with x)."),
        button: z
          .enum(["left", "middle", "right"])
          .optional()
          .describe("Mouse button (default left)."),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        await bridge.send(
          "click",
          args.group,
          {
            ref: args.ref,
            selector: args.selector,
            x: args.x,
            y: args.y,
            button: args.button,
            tabId: args.tabId
          },
          ctx.abort
        );
        return `Clicked ${describeTarget(args)} in group "${args.group}".`;
      }
    }),

    browser_double_click: tool({
      description:
        "Double-click an element, targeted by `ref`, CSS `selector`, or `x`/`y` coordinates.",
      args: {
        group,
        ref: z.string().optional(),
        selector: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        await bridge.send(
          "double_click",
          args.group,
          { ref: args.ref, selector: args.selector, x: args.x, y: args.y, tabId: args.tabId },
          ctx.abort
        );
        return `Double-clicked ${describeTarget(args)} in group "${args.group}".`;
      }
    }),

    browser_type: tool({
      description:
        "Type text into the focused element (or first focus `ref`/`selector`). Optionally press Enter after.",
      args: {
        group,
        text: z.string().describe("Text to type."),
        ref: z.string().optional(),
        selector: z.string().optional(),
        submit: z.boolean().optional().describe("Press Enter after typing."),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        await bridge.send(
          "type",
          args.group,
          {
            text: args.text,
            ref: args.ref,
            selector: args.selector,
            submit: args.submit,
            tabId: args.tabId
          },
          ctx.abort
        );
        return `Typed ${args.text.length} character(s) into ${describeTarget(args)}${args.submit ? " and submitted" : ""}.`;
      }
    }),

    browser_fill: tool({
      description:
        "Fill several form fields in one call. Each field targets a `ref` or CSS `selector` and sets its `value`.",
      args: {
        group,
        fields: z
          .array(
            z.object({
              ref: z.string().optional(),
              selector: z.string().optional(),
              value: z.string()
            })
          )
          .describe("Fields to fill, in order."),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        const data = asRecord(
          await bridge.send(
            "fill",
            args.group,
            { fields: args.fields, tabId: args.tabId },
            ctx.abort
          )
        );
        const filled = typeof data.filled === "number" ? data.filled : args.fields.length;
        const missed = args.fields.length - filled;
        const note = missed > 0 ? ` (${missed} target(s) not found)` : "";
        return `Filled ${filled} of ${args.fields.length} field(s) in group "${args.group}".${note}`;
      }
    }),

    browser_select: tool({
      description: "Choose option(s) in a <select> element, or set the selection of a control.",
      args: {
        group,
        ref: z.string().optional(),
        selector: z.string().optional(),
        value: z.string().optional().describe("Single value to select."),
        values: z.array(z.string()).optional().describe("Multiple values (multi-select)."),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        await bridge.send(
          "select",
          args.group,
          {
            ref: args.ref,
            selector: args.selector,
            value: args.value,
            values: args.values,
            tabId: args.tabId
          },
          ctx.abort
        );
        const chosen = args.values ? args.values.join(", ") : (args.value ?? "");
        return `Selected ${chosen} in ${describeTarget(args)}.`;
      }
    }),

    browser_scroll: tool({
      description:
        "Scroll the page (or an element). Provide `deltaX`/`deltaY`, or `to: 'top' | 'bottom'`.",
      args: {
        group,
        deltaX: z.number().optional(),
        deltaY: z.number().optional(),
        ref: z.string().optional().describe("Scroll within this element instead of the page."),
        to: z.enum(["top", "bottom"]).optional(),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        await bridge.send(
          "scroll",
          args.group,
          {
            deltaX: args.deltaX,
            deltaY: args.deltaY,
            ref: args.ref,
            to: args.to,
            tabId: args.tabId
          },
          ctx.abort
        );
        return `Scrolled in group "${args.group}".`;
      }
    }),

    browser_press_key: tool({
      description: 'Press a single key or chord (e.g. "Enter", "Escape", "Control+a").',
      args: {
        group,
        key: z.string().describe('Key name, e.g. "Enter".'),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        await bridge.send("press_key", args.group, { key: args.key, tabId: args.tabId }, ctx.abort);
        return `Pressed ${args.key} in group "${args.group}".`;
      }
    }),

    browser_screenshot: tool({
      description:
        "Capture a screenshot of the group's active tab and save it to disk. Returns the file path — use the read tool to view the PNG.",
      args: {
        group,
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture the full scrollable page, not just the viewport."),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        const data = (await bridge.send(
          "screenshot",
          args.group,
          { fullPage: args.fullPage, tabId: args.tabId },
          ctx.abort
        )) as ScreenshotResult;
        const path = await saveScreenshot({
          group: args.group,
          worktree: ctx.worktree,
          shot: data
        });
        deps.logger.info("browser_screenshot_saved", { group: args.group, path });
        return {
          output: `Saved screenshot to ${path} (${data.width}×${data.height}). Use the read tool to view it.`,
          metadata: { path, width: data.width, height: data.height, group: args.group }
        };
      }
    }),

    browser_snapshot: tool({
      description:
        "Capture an accessibility/DOM snapshot of the page with stable element refs. Prefer this over guessing selectors — pass the returned refs to browser_click/type/etc.",
      args: { group, tabId: z.number().optional() },
      async execute(args, ctx) {
        const data = asRecord(
          await bridge.send("snapshot", args.group, { tabId: args.tabId }, ctx.abort)
        );
        const snapshot =
          typeof data.snapshot === "string" ? data.snapshot : JSON.stringify(data, null, 2);
        return { output: snapshot, metadata: { group: args.group, refs: data.refs } };
      }
    }),

    browser_get_text: tool({
      description: "Extract the visible text / readable content of the group's active tab.",
      args: { group, tabId: z.number().optional() },
      async execute(args, ctx) {
        const data = asRecord(
          await bridge.send("get_text", args.group, { tabId: args.tabId }, ctx.abort)
        );
        return typeof data.text === "string" ? data.text : JSON.stringify(data);
      }
    }),

    browser_wait: tool({
      description:
        "Wait for a fixed delay (`ms`) or until a `selector` reaches `state` (visible/hidden/attached).",
      args: {
        group,
        ms: z.number().optional().describe("Fixed delay in milliseconds."),
        selector: z.string().optional().describe("CSS selector to wait for."),
        state: z.enum(["visible", "hidden", "attached"]).optional(),
        tabId: z.number().optional()
      },
      async execute(args, ctx) {
        if (args.ms === undefined && !args.selector) {
          throw new Error("browser_wait requires either `ms` (a delay) or `selector`");
        }
        await bridge.send(
          "wait",
          args.group,
          { ms: args.ms, selector: args.selector, state: args.state, tabId: args.tabId },
          ctx.abort
        );
        return args.selector
          ? `Waited for ${args.selector} (${args.state ?? "visible"}).`
          : `Waited ${args.ms ?? 0}ms.`;
      }
    }),

    browser_tabs: tool({
      description: "List open tab groups and their tabs. Omit `group` to list everything.",
      args: { group: z.string().optional().describe("Restrict to one group.") },
      async execute(args, ctx) {
        const data = await bridge.send("tabs", args.group ?? "", { group: args.group }, ctx.abort);
        return { output: JSON.stringify(data, null, 2), metadata: asRecord(data) };
      }
    }),

    browser_close: tool({
      description: "Close a tab (pass `tabId`) or the whole group (omit `tabId`).",
      args: { group, tabId: z.number().optional() },
      async execute(args, ctx) {
        await bridge.send("close", args.group, { tabId: args.tabId }, ctx.abort);
        return args.tabId
          ? `Closed tab ${args.tabId} in group "${args.group}".`
          : `Closed group "${args.group}".`;
      }
    })
  };
}
