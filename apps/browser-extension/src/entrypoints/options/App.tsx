import { useState } from "react";

import { ActivityPanel } from "../../components/panels/activity-panel";
import { ConnectionPanel } from "../../components/panels/connection-panel";
import { ScreenshotsPanel } from "../../components/panels/screenshots-panel";
import { StatusBadge } from "../../components/status-badge";
import { useStatus } from "../../lib/hooks";
import { cn } from "../../lib/utils";

type Tab = "connection" | "activity" | "screenshots";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "connection", label: "Connection" },
  { id: "activity", label: "Activity" },
  { id: "screenshots", label: "Screenshots" }
];

export function App() {
  const [tab, setTab] = useState<Tab>("connection");
  const status = useStatus();

  return (
    <div className="mx-auto min-h-full max-w-3xl px-6 py-8 text-fg">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">OpenCode Browser</h1>
          <p className="text-sm text-muted">
            Bridge dashboard — connection, activity and captures.
          </p>
        </div>
        <StatusBadge state={status.state} />
      </header>

      <nav className="mt-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="mt-6">
        {tab === "connection" ? <ConnectionPanel /> : null}
        {tab === "activity" ? <ActivityPanel /> : null}
        {tab === "screenshots" ? <ScreenshotsPanel /> : null}
      </main>
    </div>
  );
}
