import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

const STEPS: Array<{ title: string; body: ReactNode }> = [
  {
    title: "Start the agent with the plugin",
    body: (
      <>
        Run OpenCode with the <code>@vymalo/opencode-browser</code> plugin (or add its MCP server to
        Claude Code, Cursor, …). On first run it opens a localhost bridge and logs a one-time token.
      </>
    )
  },
  {
    title: "Paste the bridge URL and token",
    body: (
      <>
        In the <b className="font-medium opacity-100">Connection</b> tab enter the bridge URL
        (default <code>ws://127.0.0.1:4517</code>) and that token, pick an executor, then
        <i className="not-italic"> Save &amp; reconnect</i>.
      </>
    )
  },
  {
    title: "Let the agent drive",
    body: (
      <>
        Ask the agent to open a page. Tabs appear grouped by task; follow along in the{" "}
        <b className="font-medium opacity-100">Activity</b> and{" "}
        <b className="font-medium opacity-100">Screenshots</b> tabs.
      </>
    )
  }
];

const CONCEPTS: Array<{ term: string; desc: ReactNode }> = [
  {
    term: "Tab groups",
    desc: "Each task gets a named group of tabs, kept isolated and inspectable. Chromium shows them as real tab groups; Firefox tracks them logically."
  },
  {
    term: "Executors",
    desc: "CDP (Chromium) gives trusted input and full-page capture, and shows a “being debugged” banner. Content-script is the Firefox-safe fallback. Auto picks the best available."
  },
  {
    term: "Security",
    desc: "The bridge binds to 127.0.0.1 and requires the token. Prefer a dedicated browser profile — the agent can act as you on any site you're signed in to."
  }
];

export function GuidePanel() {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm opacity-80">
          <p>
            <b className="font-semibold opacity-100">OpenCode Browser</b> gives an OpenCode agent
            hands in this browser. The agent opens a small WebSocket bridge on your machine; this
            extension dials that bridge and runs the agent's commands — open, click, type, scroll,
            screenshot — against real pages.
          </p>
          <p>
            The bridge itself is localhost-only, and your settings and history stay on-device. Keep
            in mind the agent <b className="font-medium opacity-100">sees what it opens</b> — page
            text and screenshots are sent to whatever model/provider you run the agent on, so prefer
            a profile you're comfortable exposing.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Get connected</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="badge badge-primary badge-sm mt-0.5 shrink-0">{i + 1}</span>
                <div className="text-sm">
                  <p className="font-medium">{s.title}</p>
                  <p className="opacity-60">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {CONCEPTS.map((c) => (
            <div key={c.term} className="grid gap-1">
              <p className="text-sm font-medium">{c.term}</p>
              <p className="text-xs opacity-60">{c.desc}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
