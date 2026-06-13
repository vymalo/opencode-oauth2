// End-to-end local test for multi-client routing. Runs two endpoints (they race
// the same port → one host, one guest) and two fake executors (simulated
// extensions over real WebSockets), then exercises: election, target routing,
// owner-exclusivity, browser_targets, and failover (host exits → guest re-elects
// → ownership rebuilt from the executors' tabs). No browser required.
//
//   bun scripts/multi-client-test.mjs

import {
  createBunTransport,
  createEndpoint,
  decodeFrame,
  encodeFrame,
  helloFrame
} from "../packages/opencode-browser/dist/lib.js";

const PORT = 4599;
const TOKEN = "mc-test";
const URL = `ws://127.0.0.1:${PORT}`;
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bunAgentSocket = (url, h) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => h.onOpen());
  ws.addEventListener("message", (e) => h.onMessage(typeof e.data === "string" ? e.data : String(e.data)));
  ws.addEventListener("close", () => h.onClose());
  ws.addEventListener("error", () => {});
  return { send: (d) => ws.send(d), close: () => ws.close() };
};

/** A simulated extension: connects, answers commands, auto-reconnects. */
function fakeExecutor(id, label) {
  const received = [];
  const groups = [];
  let ws;
  let closed = false;
  const connect = () => {
    ws = new WebSocket(URL);
    ws.addEventListener("open", () =>
      ws.send(encodeFrame(helloFrame(TOKEN, { role: "extension", id, label, browser: "chrome" })))
    );
    ws.addEventListener("message", (e) => {
      const f = decodeFrame(String(e.data));
      if (f?.type !== "command") return;
      received.push({ action: f.action, group: f.group });
      let data = { ok: true };
      if (f.action === "open") {
        if (!groups.includes(f.group)) groups.push(f.group);
        data = { tabId: 1, url: "https://example.com", title: "Example" };
      } else if (f.action === "tabs") {
        data = { groups: groups.map((name) => ({ name, tabIds: [1] })) };
      }
      ws.send(encodeFrame({ v: 1, type: "result", id: f.id, ok: true, data }));
    });
    ws.addEventListener("close", () => {
      if (!closed) setTimeout(connect, 150);
    });
    ws.addEventListener("error", () => {});
  };
  connect();
  return { id, label, received, close: () => { closed = true; ws.close(); } };
}

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

const deps = { logger, createServerTransport: createBunTransport, createAgentSocket: bunAgentSocket };

async function main() {
  console.log("— election —");
  const a = await createEndpoint({ host: "127.0.0.1", port: PORT, token: TOKEN, timeoutMs: 5000, label: "agentA", reelectMs: 200 }, deps);
  const b = await createEndpoint({ host: "127.0.0.1", port: PORT, token: TOKEN, timeoutMs: 5000, label: "agentB", reelectMs: 200 }, deps);
  check("first endpoint hosts", a.mode() === "host");
  check("second endpoint is a guest", b.mode() === "guest");

  const e1 = fakeExecutor("chrome-1", "work");
  const e2 = fakeExecutor("chrome-2", "personal");
  await sleep(300);

  console.log("— targets + routing —");
  const targets = await a.send("targets", "", {});
  check("browser_targets lists both browsers", targets.targets.length === 2);

  await a.send("open", "alpha", { url: "x" }, undefined, "work"); // → e1
  await b.send("open", "beta", { url: "y" }, undefined, "personal"); // → e2
  await sleep(50);
  check("group alpha routed to e1(work)", e1.received.some((r) => r.group === "alpha") && !e2.received.some((r) => r.group === "alpha"));
  check("group beta routed to e2(personal)", e2.received.some((r) => r.group === "beta") && !e1.received.some((r) => r.group === "beta"));

  await a.send("click", "alpha", { ref: "e1" });
  await sleep(20);
  check("agent A drives its own group", e1.received.some((r) => r.action === "click" && r.group === "alpha"));

  console.log("— owner exclusivity —");
  let blocked = false;
  try { await b.send("click", "alpha", { ref: "e1" }); }
  catch (err) { blocked = /owned by another client/.test(String(err?.message ?? err)); }
  check("agent B blocked from agent A's group", blocked);

  console.log("— failover (host A exits → B re-elects) —");
  e1.received.length = 0;
  e2.received.length = 0;
  a.shutdown();
  await sleep(1200); // re-election + executor reconnect + ownership rebuild
  check("guest B became the new host", b.mode() === "host");

  await b.send("navigate", "beta", { url: "z" }); // B owns beta
  await sleep(40);
  check("B still drives beta after failover", e2.received.some((r) => r.action === "navigate" && r.group === "beta"));

  await b.send("click", "alpha", { ref: "e1" }); // alpha orphaned (A gone) → B adopts
  await sleep(40);
  check("B adopts orphaned group alpha and routes to e1", e1.received.some((r) => r.action === "click" && r.group === "alpha"));

  b.shutdown();
  e1.close();
  e2.close();
  await sleep(100);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
