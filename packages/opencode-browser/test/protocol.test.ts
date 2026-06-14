import { describe, expect, it } from "vitest";

import {
  cancelFrame,
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  errorFrame,
  type Frame,
  helloFrame,
  nextId,
  PROTOCOL_VERSION,
  type ResultFrame,
  resultFrame
} from "../src/protocol.js";

describe("protocol encode/decode", () => {
  it("round-trips a command frame", () => {
    const frame: CommandFrame = {
      v: PROTOCOL_VERSION,
      type: "command",
      id: "c1",
      action: "click",
      group: "research",
      params: { selector: "#go" }
    };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded).toEqual(frame);
  });

  it("round-trips a result frame", () => {
    const frame: ResultFrame = {
      v: PROTOCOL_VERSION,
      type: "result",
      id: "c1",
      ok: true,
      data: { url: "https://example.com" }
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("returns null for malformed JSON", () => {
    expect(decodeFrame("{not json")).toBeNull();
  });

  it("returns null for an unknown frame type", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, type: "nope" }))).toBeNull();
  });

  it("rejects a command frame missing required fields", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, type: "command", id: "c1" }))).toBeNull();
  });

  it("rejects a hello frame without a token", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, type: "hello" }))).toBeNull();
  });

  it("accepts a well-formed hello frame", () => {
    const decoded = decodeFrame(JSON.stringify({ v: 1, type: "hello", token: "abc" }));
    expect(decoded).toMatchObject({ type: "hello", token: "abc" });
  });

  it("normalizes ping/pong frames", () => {
    const ping = decodeFrame(JSON.stringify({ v: 9, type: "ping" })) as Frame;
    expect(ping).toEqual({ v: PROTOCOL_VERSION, type: "ping" });
  });

  it("decodes a release frame", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, type: "release" }))).toEqual({
      v: PROTOCOL_VERSION,
      type: "release"
    });
  });

  it("round-trips a cancel frame", () => {
    const frame = cancelFrame("c7");
    expect(frame).toEqual({ v: PROTOCOL_VERSION, type: "cancel", id: "c7" });
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("rejects a cancel frame without an id", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, type: "cancel" }))).toBeNull();
  });

  it("preserves a per-command timeoutMs on a command frame", () => {
    const frame: CommandFrame = {
      v: PROTOCOL_VERSION,
      type: "command",
      id: "c2",
      action: "snapshot",
      group: "g",
      params: {},
      timeoutMs: 120_000
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
});

describe("nextId", () => {
  it("produces unique, monotonic-ish ids", () => {
    const ids = new Set([nextId(), nextId(), nextId()]);
    expect(ids.size).toBe(3);
  });
});

describe("frame builders", () => {
  it("helloFrame carries the token, role and descriptors", () => {
    const f = helloFrame("tok", {
      role: "agent",
      client: "x",
      id: "e1",
      label: "L",
      browser: "chrome"
    });
    expect(f).toMatchObject({
      type: "hello",
      token: "tok",
      role: "agent",
      client: "x",
      id: "e1",
      label: "L",
      browser: "chrome"
    });
    expect(decodeFrame(encodeFrame(f))).toMatchObject({ type: "hello", token: "tok" });
  });

  it("resultFrame marks ok with data; errorFrame marks failure with code", () => {
    expect(resultFrame("c1", { a: 1 })).toEqual({
      v: PROTOCOL_VERSION,
      type: "result",
      id: "c1",
      ok: true,
      data: { a: 1 }
    });
    expect(errorFrame("c2", "boom", "timeout")).toEqual({
      v: PROTOCOL_VERSION,
      type: "result",
      id: "c2",
      ok: false,
      error: { message: "boom", code: "timeout" }
    });
  });

  it("decodes pong and rejects an event missing its name", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, type: "pong" }))).toEqual({
      v: PROTOCOL_VERSION,
      type: "pong"
    });
    expect(decodeFrame(JSON.stringify({ v: 1, type: "event" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ v: 1, type: "result", id: "x" }))).toBeNull();
  });
});
