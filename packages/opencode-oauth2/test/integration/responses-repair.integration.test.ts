import { describe, expect, it } from "vitest";

import { repairResponsesSseText } from "../../src/responses-repair.js";

// Live coverage against a real OpenAI Responses gateway (e.g. Envoy AI Gateway).
// Skips unless INTEGRATION_RESPONSES_URL is set, so the default suite stays
// hermetic. To run it:
//
//   INTEGRATION_RESPONSES_URL=https://api.ai.camer.digital/v1/responses \
//   INTEGRATION_RESPONSES_TOKEN=<bearer> \
//   INTEGRATION_RESPONSES_MODEL=qwen3-5-4b-local \
//     pnpm --filter @vymalo/opencode-oauth2 test:integration
//
// The bearer is any valid access token for the gateway (the oauth2 plugin's
// cache file is a convenient source). The model must be one the gateway serves
// on `/v1/responses` — some gateways route only a subset there.
const URL = process.env.INTEGRATION_RESPONSES_URL;
const TOKEN = process.env.INTEGRATION_RESPONSES_TOKEN;
const MODEL = process.env.INTEGRATION_RESPONSES_MODEL ?? "qwen3-5-4b-local";

type Event = Record<string, unknown>;

function parseEvents(sse: string): Event[] {
  return sse
    .split("\n\n")
    .map((b) => b.match(/data:\s*(\{[\s\S]*\})/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => JSON.parse(m[1]) as Event);
}

const needsOutputIndex = (e: Event) =>
  typeof e.type === "string" &&
  /^response\.(output_item|content_part|output_text|reasoning_text)\./.test(e.type);

describe.skipIf(!URL)("responses repair ↔ live gateway", () => {
  it("repairs a real /v1/responses stream into a spec-conformant one", async () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (TOKEN) {
      headers.Authorization = `Bearer ${TOKEN}`;
    }

    const res = await fetch(URL as string, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with: ok" }] }]
      })
    });
    expect(res.status, `gateway returned ${res.status}`).toBe(200);

    const raw = await res.text();
    const rawEvents = parseEvents(raw);

    // sanity: we actually streamed a Responses-API stream
    expect(rawEvents.some((e) => e.type === "response.output_item.added")).toBe(true);

    const repaired = parseEvents(repairResponsesSseText(raw));
    // after repair, every event a strict consumer indexes carries an output_index
    expect(repaired.filter(needsOutputIndex).every((e) => typeof e.output_index === "number")).toBe(
      true
    );

    // Document whichever side of the conformance line this gateway falls on:
    // if it already emits indices, the repair was a no-op (still conformant);
    // if it omitted them (the bug this fixes), the repair supplied them.
    const rawMissing = rawEvents
      .filter(needsOutputIndex)
      .filter((e) => e.output_index === undefined);
    console.log(
      rawMissing.length > 0
        ? `gateway omitted output_index on ${rawMissing.length} event(s) — repair supplied them`
        : "gateway already emits output_index — repair was a no-op"
    );
  });
});
