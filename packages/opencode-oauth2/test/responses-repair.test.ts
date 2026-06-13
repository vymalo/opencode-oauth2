import { describe, expect, it } from "vitest";

import {
  createResponsesRepairFetch,
  makeResponsesRepairStream,
  repairResponsesSseText
} from "../src/responses-repair.js";

// Mirrors the shape of a real Envoy-AI-Gateway Responses stream: a reasoning
// item then a message item, with NO output_index / content_index fields, and
// the reasoning item's `output_item.done` arriving late (after the message
// already opened). This is the stream that makes OpenCode fail with
// "text part <msg_id> not found".
const RAW_SSE = [
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n`,
  `event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","content":[]}}\n\n`,
  `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs_1","delta":"think"}\n\n`,
  `event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n`,
  `event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_1","part":{"type":"output_text"}}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"ok"}\n\n`,
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning"}}\n\n`,
  `event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"msg_1","text":"ok"}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n`
].join("");

function parseEvents(sse: string): Array<Record<string, unknown>> {
  return sse
    .split("\n\n")
    .map((b) => b.match(/data:\s*(\{[\s\S]*\})/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => JSON.parse(m[1]) as Record<string, unknown>);
}

describe("repairResponsesSseText", () => {
  it("injects output_index per item and content_index on content/text/reasoning events", () => {
    const events = parseEvents(repairResponsesSseText(RAW_SSE));
    const byType = (t: string) => events.filter((e) => e.type === t);

    // reasoning item → output_index 0, message item → output_index 1
    expect(byType("response.output_item.added").map((e) => e.output_index)).toEqual([0, 1]);

    const reasoningDelta = byType("response.reasoning_text.delta")[0];
    expect(reasoningDelta.output_index).toBe(0);
    expect(reasoningDelta.content_index).toBe(0);

    const textDelta = byType("response.output_text.delta")[0];
    expect(textDelta.output_index).toBe(1);
    expect(textDelta.content_index).toBe(0);

    const partAdded = byType("response.content_part.added")[0];
    expect(partAdded.output_index).toBe(1);
    expect(partAdded.content_index).toBe(0);

    // the late reasoning done still maps to its item's index
    expect(byType("response.output_item.done")[0].output_index).toBe(0);
  });

  it("leaves item-less envelope events (created/completed) without an output_index", () => {
    const events = parseEvents(repairResponsesSseText(RAW_SSE));
    expect(events.find((e) => e.type === "response.created")?.output_index).toBeUndefined();
    expect(events.find((e) => e.type === "response.completed")?.output_index).toBeUndefined();
  });

  it("is idempotent and never overwrites pre-existing indices (safe on a conformant gateway)", () => {
    const once = repairResponsesSseText(RAW_SSE);
    expect(repairResponsesSseText(once)).toBe(once);

    const conformant = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":3,"content_index":2,"delta":"x"}\n\n`;
    const out = parseEvents(repairResponsesSseText(conformant))[0];
    expect(out.output_index).toBe(3);
    expect(out.content_index).toBe(2);
  });

  it("passes through non-event blocks such as data: [DONE]", () => {
    const sse = `event: done\ndata: [DONE]\n\n`;
    expect(repairResponsesSseText(sse)).toBe(sse);
  });

  it("handles CRLF-delimited SSE frames (\\r\\n\\r\\n boundaries)", () => {
    const crlf = RAW_SSE.replace(/\n/g, "\r\n");
    const events = parseEvents(repairResponsesSseText(crlf));
    // indices are injected just as for the LF stream
    expect(
      events.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index)
    ).toEqual([0, 1]);
    expect(events.find((e) => e.type === "response.output_text.delta")?.output_index).toBe(1);
    expect(events.find((e) => e.type === "response.output_text.delta")?.content_index).toBe(0);
  });

  it("repairs a data-only frame with no event: line", () => {
    const sse = `data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}\n\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hi"}\n\n`;
    const events = parseEvents(repairResponsesSseText(sse));
    expect(events[0].output_index).toBe(0);
    expect(events[1].output_index).toBe(0);
    expect(events[1].content_index).toBe(0);
  });
});

describe("makeResponsesRepairStream", () => {
  async function pipe(chunks: string[]): Promise<string> {
    const enc = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      }
    });
    const out = source.pipeThrough(makeResponsesRepairStream());
    const dec = new TextDecoder();
    let text = "";
    for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
      text += dec.decode(chunk, { stream: true });
    }
    return text;
  }

  it("produces the same result as the text form regardless of chunk boundaries", async () => {
    const expected = repairResponsesSseText(RAW_SSE);

    // whole-string, and split at an awkward offset that bisects an event
    expect(await pipe([RAW_SSE])).toBe(expected);
    const mid = Math.floor(RAW_SSE.length / 2);
    expect(await pipe([RAW_SSE.slice(0, mid), RAW_SSE.slice(mid)])).toBe(expected);
    // byte-at-a-time torture split
    expect(await pipe([...RAW_SSE])).toBe(expected);
  });
});

describe("createResponsesRepairFetch", () => {
  const sseResponse = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

  it("repairs the SSE body for /responses streaming calls", async () => {
    const delegate = (async () => sseResponse(RAW_SSE)) as unknown as typeof fetch;
    const f = createResponsesRepairFetch(delegate);

    const res = await f("https://gw.example/v1/responses", { method: "POST" });
    const events = parseEvents(await res.text());
    expect(
      events.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index)
    ).toEqual([0, 1]);
  });

  it("passes non-/responses requests through untouched", async () => {
    const delegate = (async () =>
      new Response(`{"data":[]}`, {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    const f = createResponsesRepairFetch(delegate);

    const res = await f("https://gw.example/v1/models");
    expect(await res.text()).toBe(`{"data":[]}`);
  });

  it("passes non-streaming /responses replies through untouched", async () => {
    const json = `{"object":"response","output":[]}`;
    const delegate = (async () =>
      new Response(json, {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    const f = createResponsesRepairFetch(delegate);

    const res = await f("https://gw.example/v1/responses", { method: "POST" });
    expect(await res.text()).toBe(json);
  });

  it("repairs even when the content-type is differently cased / parameterized", async () => {
    const delegate = (async () =>
      new Response(RAW_SSE, {
        status: 200,
        headers: { "content-type": "Text/Event-Stream; charset=utf-8" }
      })) as unknown as typeof fetch;
    const f = createResponsesRepairFetch(delegate);

    const res = await f("https://gw.example/v1/responses", { method: "POST" });
    const events = parseEvents(await res.text());
    expect(
      events.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index)
    ).toEqual([0, 1]);
  });
});
