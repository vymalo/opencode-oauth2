import { describe, expect, it } from "vitest";

import {
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  type Frame,
  nextId,
  PROTOCOL_VERSION,
  type ResultFrame
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
});

describe("nextId", () => {
  it("produces unique, monotonic-ish ids", () => {
    const ids = new Set([nextId(), nextId(), nextId()]);
    expect(ids.size).toBe(3);
  });
});
