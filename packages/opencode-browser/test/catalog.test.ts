import { describe, expect, it } from "vitest";

import { BROWSER_TOOLS, type NeutralResult, TOOL_GROUPS } from "../src/catalog.js";
import { BROWSER_ACTIONS } from "../src/protocol.js";

// Permissive sample data covering the fields the various result() closures read,
// so each can be exercised without a live extension.
const SAMPLE_DATA = {
  url: "https://ex.com",
  title: "Example",
  text: "hello",
  html: "<a>x</a>",
  count: 2,
  filled: 1,
  ok: true,
  found: true,
  refs: 3,
  snapshot: "- button",
  entries: [{ a: 1 }],
  cookies: [{ name: "c" }],
  closed: [1],
  groups: [{ name: "g" }],
  targets: [{ id: "e1" }],
  base64: "AAAA",
  width: 10,
  height: 20,
  tabId: 1,
  attributes: {},
  responded: true,
  annotations: [],
  result: { value: 42 }
};
const SAMPLE_ARGS = { group: "g", ref: "e1", selector: "#x", x: 1, y: 2, mode: "confirm" };
const KINDS = new Set(["text", "json", "image"]);

describe("catalog integrity", () => {
  it("every tool maps to a real wire action and an enabled group", () => {
    for (const spec of BROWSER_TOOLS) {
      expect(BROWSER_ACTIONS).toContain(spec.action);
      expect(TOOL_GROUPS).toContain(spec.group);
      expect(spec.name.startsWith("browser_")).toBe(true);
    }
  });

  it("tool names are unique", () => {
    const names = BROWSER_TOOLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("tool params() transforms", () => {
  it("return a plain object and never throw on representative args", () => {
    for (const spec of BROWSER_TOOLS) {
      if (!spec.params) {
        continue;
      }
      const out = spec.params(SAMPLE_ARGS);
      expect(out).toBeTypeOf("object");
      expect(out).not.toBeNull();
    }
  });
});

describe("tool result() renderers", () => {
  it("return a valid NeutralResult with text for every tool", () => {
    for (const spec of BROWSER_TOOLS) {
      if (!spec.result) {
        continue;
      }
      const r: NeutralResult = spec.result(SAMPLE_DATA, SAMPLE_ARGS);
      expect(KINDS.has(r.kind), `${spec.name} kind=${r.kind}`).toBe(true);
      expect(typeof r.text).toBe("string");
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it("tolerate empty/odd executor data without throwing", () => {
    for (const spec of BROWSER_TOOLS) {
      if (!spec.result) {
        continue;
      }
      expect(() => spec.result?.({}, { group: "g" })).not.toThrow();
    }
  });
});
