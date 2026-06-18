import { describe, expect, it } from "vitest";

import { type JsonInput, toJsonSchema } from "../src/schema.js";

describe("toJsonSchema", () => {
  it("emits a JSON Schema with required/optional and every field type", () => {
    const input: JsonInput = {
      s: { type: "string", description: "a string", enum: ["a", "b"] },
      n: { type: "number" },
      b: { type: "boolean", optional: true },
      arr: { type: "array", items: { type: "string" } },
      obj: {
        type: "object",
        properties: { inner: { type: "number" }, opt: { type: "string", optional: true } }
      }
    };
    const schema = toJsonSchema(input);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["s", "n", "arr", "obj"]);
    expect((schema.properties.s as { enum: string[] }).enum).toEqual(["a", "b"]);
    expect((schema.properties.s as { description: string }).description).toBe("a string");
    expect((schema.properties.arr as { items: { type: string } }).items.type).toBe("string");
    const obj = schema.properties.obj as { required: string[]; additionalProperties: boolean };
    expect(obj.required).toEqual(["inner"]);
    expect(obj.additionalProperties).toBe(false);
  });
});
