import { clearHistory } from "../../shared/db";
import { useActions } from "../../lib/hooks";
import { timeAgo } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function ActivityPanel() {
  const actions = useActions();

  if (actions.length === 0) {
    return <p className="text-sm opacity-60">No actions recorded yet.</p>;
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm opacity-60">{actions.length} recent action(s)</p>
        <Button variant="ghost" size="sm" onClick={() => clearHistory()}>
          Clear history
        </Button>
      </div>
      <div className="overflow-hidden rounded-box border border-base-300">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>When</th>
              <th>Group</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap opacity-60">{timeAgo(a.ts)}</td>
                <td>
                  <code className="text-xs">{a.group || "—"}</code>
                </td>
                <td>
                  <Badge tone={a.ok ? "accent" : "danger"}>{a.action}</Badge>
                </td>
                <td className="max-w-[18rem] truncate opacity-70" title={a.summary}>
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
