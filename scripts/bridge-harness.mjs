// Local dev harness for @vymalo/opencode-browser — hosts the real WebSocket
// bridge (no OpenCode session needed) plus a tiny HTTP control port so commands
// can be driven with curl. Run with Bun:
//
//   bun scripts/bridge-harness.mjs
//
// Then load apps/browser-extension/.output/chrome-mv3 unpacked in Chrome, open
// the dashboard, set the bridge URL to ws://127.0.0.1:4517 and the token below,
// and Save & reconnect. Drive it with:
//
//   curl -s localhost:4519/status
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"open","group":"demo","params":{"url":"https://example.com"}}'
//   curl -s -XPOST localhost:4519/cmd -d '{"action":"screenshot","group":"demo","params":{"fullPage":true}}'
//
// Screenshots are written to scripts/harness-shots/.

import { mkdirSync } from "node:fs";
import { Bridge, createBunTransport } from "../packages/opencode-browser/dist/lib.js";

const TOKEN = process.env.OCB_TOKEN ?? "dev-token";
const WS_PORT = Number(process.env.OCB_PORT ?? 4517);
const HTTP_PORT = Number(process.env.OCB_CTL_PORT ?? 4519);
const SHOT_DIR = new URL("./harness-shots/", import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });

const log = (level) => (event, fields) =>
  console.log(`[${level}] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
const logger = { debug: () => {}, info: log("info"), warn: log("warn"), error: log("error") };

const bridge = new Bridge(
  { host: "127.0.0.1", port: WS_PORT, token: TOKEN, timeoutMs: 90_000 },
  { logger, transport: createBunTransport() }
);
bridge.start();

console.log("─".repeat(64));
console.log(`  bridge:   ws://127.0.0.1:${WS_PORT}`);
console.log(`  token:    ${TOKEN}`);
console.log(`  control:  http://127.0.0.1:${HTTP_PORT}  (GET /status, POST /cmd)`);
console.log(`  shots →   ${SHOT_DIR}`);
console.log("─".repeat(64));
console.log("Waiting for the extension to connect…");

Bun.serve({
  hostname: "127.0.0.1",
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ connected: bridge.connected });
    }
    if (req.method === "POST" && url.pathname === "/cmd") {
      const { action, group, params } = await req.json();
      try {
        const data = await bridge.send(action, group ?? "demo", params ?? {});
        if (action === "screenshot" && data && typeof data.base64 === "string") {
          const file = `${SHOT_DIR}${(group ?? "demo").replace(/[^a-z0-9_-]+/gi, "-")}-${data.width}x${data.height}.png`;
          await Bun.write(file, Buffer.from(data.base64, "base64"));
          return Response.json({
            ok: true,
            saved: file,
            width: data.width,
            height: data.height,
            partial: Boolean(data.partial)
          });
        }
        return Response.json({ ok: true, data });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }
    return new Response("opencode-browser harness", { status: 404 });
  }
});
