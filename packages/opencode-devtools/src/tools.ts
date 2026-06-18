import { randomBytes as nodeRandomBytes } from "node:crypto";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { selectTools } from "./catalog.js";
import type { Logger } from "./logging.js";
import type { Field, JsonInput } from "./schema.js";
import type { NeutralResult, ToolContext } from "./tool-spec.js";
import type { ResolvedDevtoolsOptions } from "./types.js";

const z = tool.schema;

export interface ToolDeps {
  options: ResolvedDevtoolsOptions;
  logger: Logger;
  /** Inject the execution context (clock / randomness / fetch) for tests. */
  context?: Partial<Omit<ToolContext, "options">>;
}

/** Build the full execution context, applying DI overrides. */
export function buildContext(
  options: ResolvedDevtoolsOptions,
  overrides?: Partial<Omit<ToolContext, "options">>
): ToolContext {
  return {
    options,
    now: overrides?.now ?? (() => new Date()),
    randomBytes: overrides?.randomBytes ?? ((size: number) => nodeRandomBytes(size)),
    fetchImpl: overrides?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  };
}

// ─── JSON-Schema → zod shape (OpenCode adapter only) ─────────────────────────
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
    case "record":
      schema = z.record(
        z.string(),
        field.valueType === "any" ? z.any() : z.string()
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

/** Render an adapter-neutral result into OpenCode's text-only ToolResult. */
function renderOpenCode(result: NeutralResult): string | { output: string; metadata: object } {
  if (result.kind === "text") {
    return result.text;
  }
  const metadata =
    typeof result.data === "object" && result.data !== null ? result.data : { value: result.data };
  return { output: result.text, metadata };
}

/**
 * Build the devtools tool map registered under `Hooks.tool`, filtered to the
 * enabled groups. Each tool is a thin adapter over the shared catalog: validate
 * args (zod), run the handler with the execution context, render the result.
 */
export function createDevtoolsTools(deps: ToolDeps): Record<string, ToolDefinition> {
  const ctx = buildContext(deps.options, deps.context);
  const tools: Record<string, ToolDefinition> = {};

  for (const spec of selectTools(deps.options.groups)) {
    const definition = {
      description: spec.description,
      args: buildShape(spec.input),
      async execute(args: Record<string, unknown>) {
        deps.logger.trace("devtools_tool_invoked", { tool: spec.name, group: spec.group });
        try {
          const result = await spec.handler(args, ctx);
          deps.logger.trace("devtools_tool_completed", { tool: spec.name });
          return renderOpenCode(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.warn("devtools_tool_failed", { tool: spec.name, error: message });
          throw err;
        }
      }
    } as unknown as ToolDefinition;
    tools[spec.name] = definition;
  }

  return tools;
}
