import type { NeutralResult } from "@vymalo/opencode-browser/lib";
import { describe, expect, it } from "vitest";

import { toMcpContent, toMcpError } from "../src/render.js";
import { selectTools } from "../src/server.js";

describe("toMcpContent", () => {
  it("renders text results", () => {
    const r: NeutralResult = { kind: "text", text: "done" };
    expect(toMcpContent(r)).toEqual({ content: [{ type: "text", text: "done" }] });
  });

  it("renders json results as text", () => {
    const r: NeutralResult = { kind: "json", data: { a: 1 }, text: "{a:1}" };
    expect(toMcpContent(r).content[0]).toEqual({ type: "text", text: "{a:1}" });
  });

  it("renders image results inline", () => {
    const r: NeutralResult = {
      kind: "image",
      base64: "AAAA",
      mimeType: "image/png",
      width: 100,
      height: 50,
      text: "screenshot 100×50"
    };
    const out = toMcpContent(r);
    expect(out.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(out.content[1]).toMatchObject({ type: "text" });
  });

  it("notes partial captures", () => {
    const r: NeutralResult = {
      kind: "image",
      base64: "AAAA",
      mimeType: "image/png",
      width: 100,
      height: 50,
      partial: true,
      text: "screenshot 100×50"
    };
    const out = toMcpContent(r);
    expect((out.content[1] as { text: string }).text).toMatch(/viewport only/);
  });
});

describe("toMcpError", () => {
  it("flags errors with isError", () => {
    const out = toMcpError(new Error("boom"));
    expect(out.isError).toBe(true);
    expect(out.content[0]).toEqual({ type: "text", text: "boom" });
  });
});

describe("selectTools", () => {
  it("filters by group", () => {
    const page = selectTools(["page"]);
    expect(page.every((s) => s.group === "page")).toBe(true);
    expect(page.some((s) => s.name === "browser_screenshot")).toBe(true);
    expect(page.some((s) => s.name === "browser_click")).toBe(false);
  });

  it("includes debug tools only when asked", () => {
    expect(selectTools(["page", "control"]).some((s) => s.name === "browser_eval")).toBe(false);
    expect(selectTools(["debug"]).some((s) => s.name === "browser_eval")).toBe(true);
  });

  it("includes the interactive feedback tool only when asked", () => {
    expect(
      selectTools(["page", "control"]).some((s) => s.name === "browser_request_feedback")
    ).toBe(false);
    expect(selectTools(["interactive"]).some((s) => s.name === "browser_request_feedback")).toBe(
      true
    );
  });
});
