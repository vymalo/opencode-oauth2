import { describe, expect, it } from "vitest";

import { run } from "./helpers.js";

describe("math group", () => {
  it("evaluates arithmetic with precision", async () => {
    const r = await run("math_eval", { expression: "(2 + 3) * 4" });
    expect(r.text).toBe("20");
  });

  it("evaluates functions and constants", async () => {
    const r = await run("math_eval", { expression: "sqrt(2)" });
    expect(r.text.startsWith("1.4142135623")).toBe(true);
  });

  it("does inline unit math via eval", async () => {
    const r = await run("math_eval", { expression: "1 km to m" });
    expect(r.text).toContain("1000");
  });

  it("rejects non-string expression", async () => {
    await expect(run("math_eval", { expression: 5 })).rejects.toThrow(/must be a string/);
  });

  it("refuses disabled-for-security functions", async () => {
    await expect(run("math_eval", { expression: 'import("x")' })).rejects.toThrow();
  });

  it("converts units", async () => {
    const r = await run("math_convert_unit", { value: 5, from: "km", to: "miles" });
    expect(r.text).toContain("miles");
    expect((r as { data: { result: string } }).data.result.startsWith("3.10")).toBe(true);
  });

  it("computes descriptive statistics", async () => {
    const r = await run("math_stats", { values: [1, 2, 3, 4] });
    const data = (r as { data: Record<string, unknown> }).data;
    expect(data.count).toBe(4);
    expect(data.mean).toBe(2.5);
    expect(data.median).toBe(2.5);
    expect(data.min).toBe(1);
    expect(data.max).toBe(4);
    expect(data.sum).toBe(10);
  });

  it("rejects empty stats input", async () => {
    await expect(run("math_stats", { values: [] })).rejects.toThrow(/non-empty/);
    await expect(run("math_stats", { values: [1, "x"] })).rejects.toThrow(/not a number/);
  });

  it("converts between numeric bases", async () => {
    const r = await run("math_base", { value: "255", fromBase: 10, toBase: 16 });
    const data = (r as { data: Record<string, unknown> }).data;
    expect(data.result).toBe("ff");
    expect(data.binary).toBe("11111111");
    expect(r.text).toContain("0xff");
  });

  it("parses prefixed hex input", async () => {
    const r = await run("math_base", { value: "0xff", fromBase: 16, toBase: 2 });
    expect((r as { data: { decimal: number } }).data.decimal).toBe(255);
  });

  it("rejects out-of-range bases and bad digits", async () => {
    await expect(run("math_base", { value: "1", fromBase: 1, toBase: 10 })).rejects.toThrow(/2–36/);
    await expect(run("math_base", { value: "zz", fromBase: 10, toBase: 2 })).rejects.toThrow(
      /not a valid/
    );
  });
});
