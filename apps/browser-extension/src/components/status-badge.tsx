import { Badge } from "./ui/badge";
import type { ConnectionState } from "../shared/types";

const MAP: Record<
  ConnectionState,
  { tone: "ok" | "warn" | "danger" | "neutral"; dot: string; label: string }
> = {
  connected: { tone: "ok", dot: "bg-success", label: "Connected" },
  connecting: { tone: "warn", dot: "bg-warning animate-pulse", label: "Connecting…" },
  disconnected: { tone: "neutral", dot: "bg-base-content/40", label: "Disconnected" },
  error: { tone: "danger", dot: "bg-error", label: "Error" }
};

export function StatusBadge({ state }: { state: ConnectionState }) {
  const { tone, dot, label } = MAP[state];
  return (
    <Badge tone={tone}>
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </Badge>
  );
}
