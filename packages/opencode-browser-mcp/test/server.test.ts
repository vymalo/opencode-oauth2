import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SendFn } from "@vymalo/opencode-browser/lib";
import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "../src/server.js";

/** Wire a real MCP Client to the server over an in-memory transport pair. */
async function connect(send: SendFn) {
  const server = createMcpServer(send, ["page", "control", "interactive"]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const fakeSend = (impl?: Parameters<typeof vi.fn>[0]) =>
  vi.fn(impl ?? (() => Promise.resolve({}))) as unknown as SendFn & ReturnType<typeof vi.fn>;

describe("createMcpServer", () => {
  it("lists only the enabled groups' tools, with JSON-Schema inputs", async () => {
    const client = await connect(fakeSend());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_open");
    expect(names).toContain("browser_request_feedback"); // interactive enabled
    expect(names).not.toContain("browser_eval"); // debug not enabled
    const open = tools.find((t) => t.name === "browser_open");
    expect(open?.inputSchema.type).toBe("object");
  });

  it("routes a tool call through the bridge send() and renders text", async () => {
    const send = fakeSend(() => Promise.resolve({ url: "https://x", title: "X" }));
    const client = await connect(send);
    const res = (await client.callTool({
      name: "browser_open",
      arguments: { group: "g", url: "https://x" }
    })) as CallToolResult;
    expect(send).toHaveBeenCalledWith(
      "open",
      "g",
      expect.objectContaining({ url: "https://x" }),
      undefined,
      undefined,
      undefined
    );
    expect(res.content[0]).toMatchObject({ type: "text" });
  });

  it("forwards the per-command timeout for the feedback tool", async () => {
    const send = fakeSend(() => Promise.resolve({ responded: true, annotations: [] }));
    const client = await connect(send);
    await client.callTool({
      name: "browser_request_feedback",
      arguments: { group: "g", mode: "confirm" }
    });
    expect(send).toHaveBeenCalledWith(
      "request_feedback",
      "g",
      expect.objectContaining({ mode: "confirm" }),
      undefined,
      undefined,
      300_000
    );
  });

  it("returns an MCP error result when the bridge send rejects", async () => {
    const send = fakeSend(() => Promise.reject(new Error("no browser connected")));
    const client = await connect(send);
    const res = (await client.callTool({
      name: "browser_open",
      arguments: { group: "g" }
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/no browser connected/);
  });

  it("errors on an unknown tool", async () => {
    const client = await connect(fakeSend());
    const res = (await client.callTool({ name: "browser_nope", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});
