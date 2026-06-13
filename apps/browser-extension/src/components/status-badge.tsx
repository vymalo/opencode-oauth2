import { Badge } from "./ui/badge";
import type { ConnectionState } from "../shared/types";

const MAP: Record<ConnectionState, { tone: "ok" | "warn" | "danger" | "neutral"; label: string }> =
  {
    connected: { tone: "ok", label: "Connected" },
    connecting: { tone: "warn", label: "Connecting…" },
    disconnected: { tone: "neutral", label: "Disconnected" },
    error: { tone: "danger", label: "Error" }
  };

export function StatusBadge({ state }: { state: ConnectionState }) {
  const { tone, label } = MAP[state];
  return (
    <Badge tone={tone}>
      <span
        className={
          tone === "ok"
            ? "size-1.5 rounded-full bg-ok"
            : tone === "warn"
              ? "size-1.5 rounded-full bg-warn animate-pulse"
              : tone === "danger"
                ? "size-1.5 rounded-full bg-danger"
                : "size-1.5 rounded-full bg-muted"
        }
      />
      {label}
    </Badge>
  );
}
