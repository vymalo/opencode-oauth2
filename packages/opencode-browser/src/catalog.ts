import type { BrowserAction } from "./protocol.js";
import type { Field, JsonInput, ToolGroup } from "./schema.js";

export type { ToolGroup } from "./schema.js";

export const TOOL_GROUPS: readonly ToolGroup[] = ["page", "control", "debug"] as const;
/** Groups registered when the operator doesn't specify — `debug` is opt-in. */
export const DEFAULT_GROUPS: readonly ToolGroup[] = ["page", "control"] as const;

/**
 * Adapter-neutral result of a tool call. The OpenCode adapter renders these to
 * its text-only `{ output, metadata }`; the MCP adapter renders text/json to a
 * TextContent and image to an inline ImageContent block.
 */
export type NeutralResult =
  | { kind: "text"; text: string }
  | { kind: "json"; data: unknown; text: string }
  | {
      kind: "image";
      base64: string;
      mimeType: string;
      width: number;
      height: number;
      partial?: boolean;
      text: string;
    };

export interface ToolSpec {
  name: string;
  group: ToolGroup;
  /** Wire action sent to the extension. */
  action: BrowserAction;
  description: string;
  input: JsonInput;
  /** Build the command params from validated args (default: the args verbatim). */
  params?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Shape the extension's reply into a neutral result (default: a short ack). */
  result?: (data: unknown, args: Record<string, unknown>) => NeutralResult;
}

// ─── reusable fields ─────────────────────────────────────────────────────────
const group: Field = {
  type: "string",
  description: "Named tab group the action targets. Created on first browser_open."
};
const tabId: Field = {
  type: "number",
  optional: true,
  description: "Specific tab id; defaults to the group's active tab."
};
const refField: Field = {
  type: "string",
  optional: true,
  description: "Element ref from a prior browser_snapshot."
};
const selectorField: Field = { type: "string", optional: true, description: "CSS selector." };

// ─── helpers ─────────────────────────────────────────────────────────────────
function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function describeTarget(a: Record<string, unknown>): string {
  if (typeof a.ref === "string") {
    return `ref ${a.ref}`;
  }
  if (typeof a.selector === "string") {
    return `selector ${a.selector}`;
  }
  if (typeof a.x === "number" && typeof a.y === "number") {
    return `(${a.x}, ${a.y})`;
  }
  return "element";
}
const text = (t: string): NeutralResult => ({ kind: "text", text: t });

/**
 * The single source of truth for the browser tool surface, shared by the
 * OpenCode plugin and the MCP server. Filter by `group` to gate what an agent
 * sees.
 */
export const BROWSER_TOOLS: readonly ToolSpec[] = [
  {
    name: "browser_open",
    group: "control",
    action: "open",
    description:
      "Open a new browser tab inside a named tab group (creates the group if it doesn't exist yet). Returns the tab id, final URL and page title.",
    input: {
      group,
      url: { type: "string", optional: true, description: "URL to load. Omit for a blank tab." },
      focus: {
        type: "boolean",
        optional: true,
        description: "Bring the tab to the foreground (default true)."
      }
    },
    result: (data, args) => {
      const d = rec(data);
      return {
        kind: "json",
        data: d,
        text: `Opened tab in group "${args.group}": ${d.title ?? "(untitled)"} — ${d.url ?? args.url ?? "about:blank"}`
      };
    }
  },
  {
    name: "browser_navigate",
    group: "control",
    action: "navigate",
    description: "Navigate an existing tab in the group to a new URL.",
    input: { group, url: { type: "string", description: "URL to navigate to." }, tabId },
    result: (data, args) => {
      const d = rec(data);
      return {
        kind: "json",
        data: d,
        text: `Navigated to ${d.url ?? args.url} (${d.title ?? ""})`.trim()
      };
    }
  },
  {
    name: "browser_click",
    group: "control",
    action: "click",
    description:
      "Click an element. Target it by `ref` (from browser_snapshot, most reliable), CSS `selector`, or absolute `x`/`y` coordinates.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      x: { type: "number", optional: true, description: "Absolute x coordinate (with y)." },
      y: { type: "number", optional: true, description: "Absolute y coordinate (with x)." },
      button: {
        type: "string",
        optional: true,
        enum: ["left", "middle", "right"],
        description: "Mouse button (default left)."
      },
      tabId
    },
    result: (_data, args) => text(`Clicked ${describeTarget(args)} in group "${args.group}".`)
  },
  {
    name: "browser_double_click",
    group: "control",
    action: "double_click",
    description:
      "Double-click an element, targeted by `ref`, CSS `selector`, or `x`/`y` coordinates.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      x: { type: "number", optional: true },
      y: { type: "number", optional: true },
      tabId
    },
    result: (_data, args) =>
      text(`Double-clicked ${describeTarget(args)} in group "${args.group}".`)
  },
  {
    name: "browser_type",
    group: "control",
    action: "type",
    description:
      "Type text into the focused element (or first focus `ref`/`selector`). Optionally press Enter after.",
    input: {
      group,
      text: { type: "string", description: "Text to type." },
      ref: refField,
      selector: selectorField,
      submit: { type: "boolean", optional: true, description: "Press Enter after typing." },
      tabId
    },
    result: (_data, args) =>
      text(
        `Typed ${String(args.text ?? "").length} character(s) into ${describeTarget(args)}${args.submit ? " and submitted" : ""}.`
      )
  },
  {
    name: "browser_fill",
    group: "control",
    action: "fill",
    description:
      "Fill several form fields in one call. Each field targets a `ref` or CSS `selector` and sets its `value`.",
    input: {
      group,
      fields: {
        type: "array",
        description: "Fields to fill, in order.",
        items: {
          type: "object",
          properties: { ref: refField, selector: selectorField, value: { type: "string" } }
        }
      },
      tabId
    },
    result: (data, args) => {
      const requested = Array.isArray(args.fields) ? args.fields.length : 0;
      const filled =
        typeof rec(data).filled === "number" ? (rec(data).filled as number) : requested;
      const missed = requested - filled;
      return text(
        `Filled ${filled} of ${requested} field(s) in group "${args.group}".${missed > 0 ? ` (${missed} not found)` : ""}`
      );
    }
  },
  {
    name: "browser_select",
    group: "control",
    action: "select",
    description: "Choose option(s) in a <select> element, or set the selection of a control.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      value: { type: "string", optional: true, description: "Single value to select." },
      values: {
        type: "array",
        optional: true,
        description: "Multiple values (multi-select).",
        items: { type: "string" }
      },
      tabId
    },
    result: (_data, args) => {
      const chosen = Array.isArray(args.values) ? args.values.join(", ") : (args.value ?? "");
      return text(`Selected ${chosen} in ${describeTarget(args)}.`);
    }
  },
  {
    name: "browser_scroll",
    group: "control",
    action: "scroll",
    description:
      "Scroll the page (or an element). Provide `deltaX`/`deltaY`, or `to: 'top' | 'bottom'`.",
    input: {
      group,
      deltaX: { type: "number", optional: true },
      deltaY: { type: "number", optional: true },
      ref: {
        type: "string",
        optional: true,
        description: "Scroll within this element instead of the page."
      },
      to: { type: "string", optional: true, enum: ["top", "bottom"] },
      tabId
    },
    result: (_data, args) => text(`Scrolled in group "${args.group}".`)
  },
  {
    name: "browser_press_key",
    group: "control",
    action: "press_key",
    description: 'Press a single key or chord (e.g. "Enter", "Escape", "Control+a").',
    input: { group, key: { type: "string", description: 'Key name, e.g. "Enter".' }, tabId },
    result: (_data, args) => text(`Pressed ${args.key} in group "${args.group}".`)
  },
  {
    name: "browser_wait",
    group: "control",
    action: "wait",
    description:
      "Wait for a fixed delay (`ms`) or until a `selector` reaches `state` (visible/hidden/attached).",
    input: {
      group,
      ms: { type: "number", optional: true, description: "Fixed delay in milliseconds." },
      selector: { type: "string", optional: true, description: "CSS selector to wait for." },
      state: { type: "string", optional: true, enum: ["visible", "hidden", "attached"] },
      tabId
    },
    result: (_data, args) =>
      text(
        args.selector
          ? `Waited for ${args.selector} (${args.state ?? "visible"}).`
          : `Waited ${args.ms ?? 0}ms.`
      )
  },
  {
    name: "browser_close",
    group: "control",
    action: "close",
    description: "Close a tab (pass `tabId`) or the whole group (omit `tabId`).",
    input: { group, tabId },
    result: (_data, args) =>
      text(
        args.tabId
          ? `Closed tab ${args.tabId} in group "${args.group}".`
          : `Closed group "${args.group}".`
      )
  },
  {
    name: "browser_release",
    group: "control",
    action: "release",
    description:
      "Release control of the browser: stop driving and detach the debugger (clears the 'being debugged' banner) without closing tabs. The next browser_* call re-attaches. Use this when you're done so the user gets their browser back.",
    input: {},
    result: () =>
      text("Released browser control. Tabs are left open; the next browser_* action re-attaches.")
  },
  {
    name: "browser_snapshot",
    group: "page",
    action: "snapshot",
    description:
      "Capture an accessibility/DOM snapshot of the page with stable element refs. Prefer this over guessing selectors — pass the returned refs to browser_click/type/etc.",
    input: { group, tabId },
    result: (data) => {
      const d = rec(data);
      return text(typeof d.snapshot === "string" ? d.snapshot : JSON.stringify(d, null, 2));
    }
  },
  {
    name: "browser_get_text",
    group: "page",
    action: "get_text",
    description: "Extract the visible text / readable content of the group's active tab.",
    input: { group, tabId },
    result: (data) => {
      const d = rec(data);
      return text(typeof d.text === "string" ? d.text : JSON.stringify(d));
    }
  },
  {
    name: "browser_tabs",
    group: "page",
    action: "tabs",
    description: "List open tab groups and their tabs. Omit `group` to list everything.",
    input: { group: { type: "string", optional: true, description: "Restrict to one group." } },
    params: (args) => ({ group: args.group }),
    result: (data) => ({ kind: "json", data, text: JSON.stringify(data, null, 2) })
  },
  {
    name: "browser_screenshot",
    group: "page",
    action: "screenshot",
    description:
      "Capture a screenshot of the group's active tab. Returns the image (the OpenCode plugin saves it to disk and returns the path — use the read tool to view it).",
    input: {
      group,
      fullPage: {
        type: "boolean",
        optional: true,
        description: "Capture the full scrollable page, not just the viewport."
      },
      tabId
    },
    result: (data) => {
      const d = rec(data);
      const width = Number(d.width ?? 0);
      const height = Number(d.height ?? 0);
      return {
        kind: "image",
        base64: String(d.base64 ?? ""),
        mimeType: "image/png",
        width,
        height,
        partial: Boolean(d.partial),
        text: `screenshot ${width}×${height}`
      };
    }
  }
];
