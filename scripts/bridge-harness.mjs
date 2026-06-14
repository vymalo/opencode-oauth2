// Local dev harness for @vymalo/opencode-browser — hosts the bridge endpoint
// (broker) with no OpenCode session, plus a tiny HTTP control port so commands
// can be driven with curl against a REAL extension. Run with Bun:
//
//   pnpm -r build && bun scripts/bridge-harness.mjs
//
// Then load apps/browser-extension/.output/chrome-mv3 unpacked, open the
// dashboard, set ws://127.0.0.1:4517 + the token below, Save & reconnect. Drive:
//
//   curl -s localhost:4519/status
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"open","group":"demo","params":{"url":"https://example.com"}}'
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"targets","group":"","params":{}}'
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"screenshot","group":"demo","params":{"fullPage":true}}'
//
// Human-in-the-loop feedback (blocks until you answer in the browser). `timeoutMs`
// raises the broker deadline so the prompt waits for you:
//
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"request_feedback","group":"demo","timeoutMs":300000,"params":{"mode":"confirm","prompt":"Looks right?","timeoutMs":290000}}'
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"request_feedback","group":"demo","timeoutMs":300000,"params":{"mode":"point","prompt":"Click the thing I mean","timeoutMs":290000}}'
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"request_feedback","group":"demo","timeoutMs":300000,"params":{"mode":"region","timeoutMs":290000}}'
//
// Side-panel fallback: open a page that blocks injection first, e.g.
//   ...open ... '{"params":{"url":"https://chromewebstore.google.com"}}'
// then request_feedback → the badge turns "?", click the toolbar icon to open
// the side panel and annotate the screenshot.
//
// Screenshots are written to scripts/harness-shots/.

import { mkdirSync } from "node:fs";
import {
  createEndpoint,
  createNodeAgentSocket,
  createNodeTransport
} from "../packages/opencode-browser/dist/lib.js";

const TOKEN = process.env.OCB_TOKEN ?? "dev-token";
const WS_PORT = Number(process.env.OCB_PORT ?? 4517);
const HTTP_PORT = Number(process.env.OCB_CTL_PORT ?? 4519);
const SHOT_DIR = new URL("./harness-shots/", import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });

const log = (level) => (event, fields) =>
  console.log(`[${level}] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
const logger = { debug: () => {}, info: log("info"), warn: log("warn"), error: log("error") };

const endpoint = await createEndpoint(
  { host: "127.0.0.1", port: WS_PORT, token: TOKEN, timeoutMs: 90_000, label: "harness" },
  { logger, createServerTransport: createNodeTransport, createAgentSocket: createNodeAgentSocket }
);

console.log("─".repeat(64));
console.log(`  bridge:   ws://127.0.0.1:${WS_PORT}   (mode: ${endpoint.mode()})`);
console.log(`  token:    ${TOKEN}`);
console.log(`  control:  http://127.0.0.1:${HTTP_PORT}  (GET /status, POST /cmd)`);
console.log(`  shots →   ${SHOT_DIR}`);
console.log("─".repeat(64));
console.log("Load the extension, paste the URL + token, then drive with curl.");

Bun.serve({
  hostname: "127.0.0.1",
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ mode: endpoint.mode(), executors: endpoint.broker()?.executorCount ?? null });
    }
    if (req.method === "POST" && url.pathname === "/cmd") {
      const { action, group, params, target, timeoutMs } = await req.json();
      try {
        const data = await endpoint.send(action, group ?? "", params ?? {}, undefined, target, timeoutMs);
        if (action === "screenshot" && data && typeof data.base64 === "string") {
          const file = `${SHOT_DIR}${(group ?? "demo").replace(/[^a-z0-9_-]+/gi, "-")}-${data.width}x${data.height}.png`;
          await Bun.write(file, Buffer.from(data.base64, "base64"));
          return Response.json({ ok: true, saved: file, width: data.width, height: data.height, partial: Boolean(data.partial) });
        }
        return Response.json({ ok: true, data });
      } catch (err) {
        return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
      }
    }
    return new Response("opencode-browser harness", { status: 404 });
  }
});
