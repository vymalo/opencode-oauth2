import { describe, expect, it } from "vitest";

import { run } from "./helpers.js";

describe("convert group", () => {
  it("converts JSON to YAML and back", async () => {
    const toYaml = await run("convert_data", {
      input: '{"name":"x","nested":{"a":1}}',
      from: "json",
      to: "yaml"
    });
    expect(toYaml.text).toContain("name: x");
    const toJson = await run("convert_data", { input: toYaml.text, from: "yaml", to: "json" });
    expect(JSON.parse(toJson.text)).toEqual({ name: "x", nested: { a: 1 } });
  });

  it("converts JSON to TOML (top-level table)", async () => {
    const r = await run("convert_data", {
      input: '{"title":"hi","n":2}',
      from: "json",
      to: "toml"
    });
    expect(r.text).toContain('title = "hi"');
  });

  it("rejects TOML output for non-object roots", async () => {
    await expect(
      run("convert_data", { input: "[1,2,3]", from: "json", to: "toml" })
    ).rejects.toThrow(/top-level object/);
  });

  it("converts CSV to JSON rows and back", async () => {
    const toJson = await run("convert_data", {
      input: "name,age\nAlice,30\nBob,25",
      from: "csv",
      to: "json"
    });
    const rows = JSON.parse(toJson.text);
    expect(rows).toEqual([
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 }
    ]);
    const toCsv = await run("convert_data", { input: toJson.text, from: "json", to: "csv" });
    expect(toCsv.text.split(/\r?\n/)[0]).toBe("name,age");
  });

  it("reports CSV parse errors", async () => {
    await expect(
      run("convert_data", { input: 'a,b\n"unterminated', from: "csv", to: "json" })
    ).rejects.toThrow(/CSV parse error/);
  });

  it("runs a JSONPath query over JSON", async () => {
    const r = await run("convert_query", {
      input: '{"items":[{"name":"a"},{"name":"b"}]}',
      path: "$.items[*].name"
    });
    const data = (r as { data: { matches: unknown[]; count: number } }).data;
    expect(data.matches).toEqual(["a", "b"]);
    expect(data.count).toBe(2);
  });

  it("refuses script/filter expressions (no eval — sandbox)", async () => {
    await expect(
      run("convert_query", {
        input: '{"items":[{"name":"a","admin":true}]}',
        path: "$.items[?(@.admin)].name"
      })
    ).rejects.toThrow(/Eval|prevented/i);
  });

  it("runs a JSONPath query over YAML with no matches", async () => {
    const r = await run("convert_query", {
      input: "items:\n  - name: a\n",
      path: "$.missing",
      from: "yaml"
    });
    expect(r.text).toBe("(no matches)");
  });
});
