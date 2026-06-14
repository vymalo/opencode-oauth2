import { useState } from "react";

import { ActivityPanel } from "../../components/panels/activity-panel";
import { ConnectionPanel } from "../../components/panels/connection-panel";
import { GuidePanel } from "../../components/panels/guide-panel";
import { ScreenshotsPanel } from "../../components/panels/screenshots-panel";
import { StatusBadge } from "../../components/status-badge";
import { useStatus } from "../../lib/hooks";

type Tab = "guide" | "connection" | "activity" | "screenshots";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "guide", label: "Guide" },
  { id: "connection", label: "Connection" },
  { id: "activity", label: "Activity" },
  { id: "screenshots", label: "Screenshots" }
];

export function App() {
  const [tab, setTab] = useState<Tab>("guide");
  const status = useStatus();

  return (
    <div className="mx-auto min-h-full max-w-3xl bg-base-100 px-6 py-8 text-base-content">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">OpenCode Browser</h1>
          <p className="text-sm opacity-60">
            Bridge dashboard — guide, connection, activity and captures.
          </p>
        </div>
        <StatusBadge state={status.state} />
      </header>

      <nav className="tabs tabs-border mt-6">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="mt-6">
        {tab === "guide" ? <GuidePanel /> : null}
        {tab === "connection" ? <ConnectionPanel /> : null}
        {tab === "activity" ? <ActivityPanel /> : null}
        {tab === "screenshots" ? <ScreenshotsPanel /> : null}
      </main>
    </div>
  );
}
