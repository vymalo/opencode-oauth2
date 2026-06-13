import { clearHistory } from "../../shared/db";
import { useActions } from "../../lib/hooks";
import { timeAgo } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function ActivityPanel() {
  const actions = useActions();

  if (actions.length === 0) {
    return <p className="text-sm text-muted">No actions recorded yet.</p>;
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{actions.length} recent action(s)</p>
        <Button variant="ghost" size="sm" onClick={() => clearHistory()}>
          Clear history
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Group</th>
              <th className="px-3 py-2 text-left font-medium">Action</th>
              <th className="px-3 py-2 text-left font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-2 text-muted">{timeAgo(a.ts)}</td>
                <td className="px-3 py-2">
                  <code className="text-xs">{a.group || "—"}</code>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={a.ok ? "accent" : "danger"}>{a.action}</Badge>
                </td>
                <td className="max-w-[18rem] truncate px-3 py-2 text-muted" title={a.summary}>
                  {a.summary}
                  {typeof a.durationMs === "number" ? (
                    <span className="ml-1 text-xs opacity-60">· {a.durationMs}ms</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
