import type { NeutralResult } from "@vymalo/opencode-devtools/lib";
import { describe, expect, it } from "vitest";

import { toMcpContent, toMcpError } from "../src/render.js";

describe("toMcpContent", () => {
  it("renders a text result", () => {
    const r = toMcpContent({ kind: "text", text: "hi" } as NeutralResult);
    expect(r).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("renders a json result via its self-sufficient text", () => {
    const r = toMcpContent({ kind: "json", text: "summary", data: { a: 1 } } as NeutralResult);
    expect(r.content[0]).toEqual({ type: "text", text: "summary" });
  });
});

describe("toMcpError", () => {
  it("wraps Error and non-Error into an error result", () => {
    expect(toMcpError(new Error("boom"))).toEqual({
      content: [{ type: "text", text: "boom" }],
      isError: true
    });
    expect(toMcpError("plain")).toEqual({
      content: [{ type: "text", text: "plain" }],
      isError: true
    });
  });
});
