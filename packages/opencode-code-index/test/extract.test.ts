import { describe, expect, it } from "vitest";

import { extractFromSource, grammarForExtension, SUPPORTED_EXTENSIONS } from "../src/extract.js";

describe("extractFromSource", () => {
  it("extracts function, method, and class definitions", () => {
    const src = `
      export function alpha() { return 1; }
      export const beta = () => alpha();
      class Service {
        run() { return this.help(); }
        help() { return 2; }
      }
    `;
    const { defs } = extractFromSource(src, "ts");
    const byName = Object.fromEntries(defs.map((d) => [d.name, d.kind]));
    expect(byName.alpha).toBe("function");
    expect(byName.beta).toBe("function"); // arrow-const
    expect(byName.Service).toBe("class");
    expect(byName.run).toBe("method");
    expect(byName.help).toBe("method");
  });

  it("records bare calls and new-expressions with name confidence", () => {
    const src = `
      function caller() {
        helper();
        return new Widget();
      }
    `;
    const { refs } = extractFromSource(src, "ts");
    const helper = refs.find((r) => r.dstName === "helper");
    const widget = refs.find((r) => r.dstName === "Widget");
    expect(helper).toMatchObject({ caller: "caller", kind: "call", confidence: "name" });
    expect(widget).toMatchObject({ caller: "caller", kind: "new", confidence: "name" });
  });

  it("records this.method() as a `this`-confidence edge", () => {
    const src = `
      class C {
        a() { return this.b(); }
        b() { return 1; }
      }
    `;
    const { refs } = extractFromSource(src, "ts");
    const edge = refs.find((r) => r.dstName === "b");
    expect(edge).toMatchObject({ caller: "a", kind: "method", confidence: "this" });
  });

  it("drops generic obj.method() and builtin calls (noise)", () => {
    const src = `
      function f(logger: any) {
        logger.debug("x");
        Date.now();
        [].push(1);
      }
    `;
    const { refs } = extractFromSource(src, "ts");
    // none of debug/now/push are our symbols — they must not become edges
    expect(refs.map((r) => r.dstName)).not.toContain("debug");
    expect(refs.map((r) => r.dstName)).not.toContain("now");
    expect(refs.map((r) => r.dstName)).not.toContain("push");
  });

  it("attributes top-level calls to the <module> caller", () => {
    const { refs } = extractFromSource(`bootstrap();`, "ts");
    expect(refs[0]).toMatchObject({ caller: "<module>", dstName: "bootstrap" });
  });

  it("parses tsx/jsx via the tsx grammar", () => {
    const { defs } = extractFromSource(`export function View() { return <div/>; }`, "tsx");
    expect(defs.map((d) => d.name)).toContain("View");
  });

  it("returns empty for unsupported extensions", () => {
    expect(extractFromSource("# hi", "md")).toEqual({ defs: [], refs: [] });
    expect(grammarForExtension("md")).toBeNull();
    expect(grammarForExtension("ts")).not.toBeNull();
  });

  it("declares the supported extension set", () => {
    expect(SUPPORTED_EXTENSIONS).toContain("ts");
    expect(SUPPORTED_EXTENSIONS).toContain("tsx");
  });
});
