/**
 * A tiny, neutral schema vocabulary for tool arguments. The tool catalog
 * (`catalog.ts`) is the single source of truth; each adapter turns these specs
 * into its own format:
 *   - the OpenCode plugin builds a zod shape (see `inputToZodShape` in tools.ts),
 *   - the MCP server emits standard JSON Schema via `toJsonSchema` below.
 *
 * Keeping the vocabulary small (string/number/boolean/array/object + enum +
 * optional + description) avoids dragging a specific zod version across the
 * package boundary while still covering every tool's args.
 */

export type ToolGroup = "page" | "control" | "debug" | "interactive";

export interface StringField {
  type: "string";
  description?: string;
  optional?: boolean;
  enum?: readonly string[];
}
export interface NumberField {
  type: "number";
  description?: string;
  optional?: boolean;
}
export interface BooleanField {
  type: "boolean";
  description?: string;
  optional?: boolean;
}
export interface ArrayField {
  type: "array";
  description?: string;
  optional?: boolean;
  items: Field;
}
export interface ObjectField {
  type: "object";
  description?: string;
  optional?: boolean;
  properties: Record<string, Field>;
}
export type Field = StringField | NumberField | BooleanField | ArrayField | ObjectField;

/** Top-level argument map for a tool. */
export type JsonInput = Record<string, Field>;

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

function fieldToJsonSchema(field: Field): Record<string, unknown> {
  const out: Record<string, unknown> = { type: field.type };
  if (field.description) {
    out.description = field.description;
  }
  if (field.type === "string" && field.enum) {
    out.enum = [...field.enum];
  }
  if (field.type === "array") {
    out.items = fieldToJsonSchema(field.items);
  }
  if (field.type === "object") {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(field.properties)) {
      properties[key] = fieldToJsonSchema(value);
      if (!value.optional) {
        required.push(key);
      }
    }
    out.properties = properties;
    out.required = required;
    out.additionalProperties = false;
  }
  return out;
}

/** Convert a tool's input spec to a standard JSON Schema object (for MCP). */
export function toJsonSchema(input: JsonInput): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(input)) {
    properties[key] = fieldToJsonSchema(field);
    if (!field.optional) {
      required.push(key);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}
