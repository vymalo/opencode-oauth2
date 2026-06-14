import { describe, expect, it } from "vitest";

import type { JsonInput } from "../src/schema.js";
import { toJsonSchema } from "../src/schema.js";

describe("toJsonSchema", () => {
  it("marks non-optional fields required and omits optional ones", () => {
    const input: JsonInput = {
      group: { type: "string", description: "the group" },
      tabId: { type: "number", optional: true }
    };
    const schema = toJsonSchema(input);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["group"]);
    expect(schema.properties.group).toEqual({ type: "string", description: "the group" });
    expect(schema.properties.tabId).toEqual({ type: "number" });
  });

  it("emits string enums", () => {
    const schema = toJsonSchema({
      mode: { type: "string", enum: ["a", "b"] as const }
    });
    expect(schema.properties.mode).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("renders array items recursively", () => {
    const schema = toJsonSchema({
      options: { type: "array", items: { type: "string" } }
    });
    expect(schema.properties.options).toEqual({ type: "array", items: { type: "string" } });
  });

  it("renders nested objects with their own required set", () => {
    const schema = toJsonSchema({
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            selector: { type: "string", optional: true },
            value: { type: "string" }
          }
        }
      }
    });
    const items = (schema.properties.fields as { items: Record<string, unknown> }).items;
    expect(items.type).toBe("object");
    expect(items.required).toEqual(["value"]);
    expect(items.additionalProperties).toBe(false);
  });

  it("produces an empty required array when everything is optional", () => {
    const schema = toJsonSchema({ a: { type: "boolean", optional: true } });
    expect(schema.required).toEqual([]);
  });
});
