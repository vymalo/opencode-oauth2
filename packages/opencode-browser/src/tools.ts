import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";

import type { AgentEndpoint } from "./broker.js";
import { BROWSER_TOOLS, type NeutralResult } from "./catalog.js";
import type { Logger } from "./logging.js";
import type { Field, JsonInput } from "./schema.js";
import type { ResolvedBrowserOptions, ScreenshotResult } from "./types.js";

const z = tool.schema;

/** How a tool reaches the bridge — the endpoint's `send` (host or guest). */
export type SendFn = AgentEndpoint["send"];

/** Where the screenshot tool gets its disk-write behavior; swappable in tests. */
export type SaveScreenshot = (input: {
  group: string;
  worktree: string;
  shot: ScreenshotResult;
}) => Promise<string>;

export interface ToolDeps {
  send: SendFn;
  options: ResolvedBrowserOptions;
  logger: Logger;
  saveScreenshot?: SaveScreenshot;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
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

// ─── JSON-Schema → zod shape (OpenCode adapter only) ─────────────────────────
// `tool()` wants a zod raw shape built with the host's zod (`tool.schema`).
// A minimal structural builder type keeps the conversion honest without
// dragging in a concrete zod version.
interface ZodBuilder {
  optional(): ZodBuilder;
  describe(description: string): ZodBuilder;
}

function fieldToZod(field: Field): ZodBuilder {
  let schema: ZodBuilder;
  switch (field.type) {
    case "string":
      schema = (field.enum
        ? z.enum(field.enum as [string, ...string[]])
        : z.string()) as unknown as ZodBuilder;
      break;
    case "number":
      schema = z.number() as unknown as ZodBuilder;
      break;
    case "boolean":
      schema = z.boolean() as unknown as ZodBuilder;
      break;
    case "array":
      schema = z.array(
        fieldToZod(field.items) as unknown as Parameters<typeof z.array>[0]
      ) as unknown as ZodBuilder;
      break;
    case "object":
      schema = z.object(
        buildShape(field.properties) as unknown as Parameters<typeof z.object>[0]
      ) as unknown as ZodBuilder;
      break;
  }
  if (field.description) {
    schema = schema.describe(field.description);
  }
  if (field.optional) {
    schema = schema.optional();
  }
  return schema;
}

function buildShape(input: JsonInput): Record<string, ZodBuilder> {
  const shape: Record<string, ZodBuilder> = {};
  for (const [key, field] of Object.entries(input)) {
    shape[key] = fieldToZod(field);
  }
  return shape;
}

interface RenderDeps {
  group: string;
  worktree: string;
  saveScreenshot: SaveScreenshot;
  logger: Logger;
}

/** Render an adapter-neutral result into OpenCode's text-only ToolResult. */
async function renderOpenCode(result: NeutralResult, deps: RenderDeps) {
  if (result.kind === "text") {
    return result.text;
  }
  if (result.kind === "json") {
    return { output: result.text, metadata: asRecord(result.data) };
  }
  // image → write the PNG to disk and hand back the path (tool output is text).
  const path = await deps.saveScreenshot({
    group: deps.group,
    worktree: deps.worktree,
    shot: {
      base64: result.base64,
      width: result.width,
      height: result.height,
      partial: result.partial
    }
  });
  deps.logger.info("browser_screenshot_saved", { group: deps.group, path });
  const partialNote = result.partial
    ? " Note: only the viewport was captured — this executor can't capture beyond it."
    : "";
  return {
    output: `Saved screenshot to ${path} (${result.width}×${result.height}). Use the read tool to view it.${partialNote}`,
    metadata: {
      path,
      width: result.width,
      height: result.height,
      partial: Boolean(result.partial),
      group: deps.group
    }
  };
}

/**
 * Build the `browser_*` tool map registered under `Hooks.tool`, filtered to the
 * enabled groups. Each tool is a thin adapter over the shared catalog: validate
 * args (zod), forward to the bridge, render the neutral result.
 */
export function createBrowserTools(deps: ToolDeps): Record<string, ToolDefinition> {
  const enabled = new Set(deps.options.groups);
  const saveScreenshot = deps.saveScreenshot ?? makeSaveScreenshot(deps.options);
  const tools: Record<string, ToolDefinition> = {};

  for (const spec of BROWSER_TOOLS) {
    if (!enabled.has(spec.group)) {
      continue;
    }
    const definition = {
      description: spec.description,
      args: buildShape(spec.input),
      async execute(args: Record<string, unknown>, ctx: ToolContext) {
        const group = typeof args.group === "string" ? args.group : "";
        const target = typeof args.target === "string" ? args.target : undefined;
        const params = spec.params ? spec.params(args) : args;
        const data = await deps.send(spec.action, group, params, ctx.abort, target, spec.timeoutMs);
        const result: NeutralResult = spec.result
          ? spec.result(data, args)
          : { kind: "text", text: `${spec.name} ok` };
        return renderOpenCode(result, {
          group,
          worktree: ctx.worktree,
          saveScreenshot,
          logger: deps.logger
        });
      }
    } as unknown as ToolDefinition;
    tools[spec.name] = definition;
  }

  return tools;
}
