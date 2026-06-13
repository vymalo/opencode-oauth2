import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-user state file so multiple adapters (plugin + MCP server) on one machine
 * share a bridge token without the operator wiring one up. Best-effort: a
 * simultaneous cold start can race (each generates its own token before either
 * writes); set an explicit token if you need that guaranteed. The extension
 * still needs the token pasted into its dashboard.
 */
const FILE = join(tmpdir(), "opencode-browser-bridge.json");

export interface BridgeFile {
  port?: number;
  token?: string;
}

export function readBridgeFile(): BridgeFile | null {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as BridgeFile;
  } catch {
    return null;
  }
}

export function writeBridgeFile(port: number, token: string): void {
  try {
    writeFileSync(FILE, JSON.stringify({ port, token }), { mode: 0o600 });
    chmodSync(FILE, 0o600);
  } catch {
    /* best-effort */
  }
}

export type TokenSource = "explicit" | "file" | "generated";

/** Resolve the bridge token: explicit option wins, else a shared file, else generate. */
export function resolveSharedToken(
  port: number,
  explicit: string | undefined,
  generate: () => string
): { token: string; source: TokenSource } {
  if (explicit && explicit.length > 0) {
    return { token: explicit, source: "explicit" };
  }
  const existing = readBridgeFile();
  if (existing?.token && (existing.port === undefined || existing.port === port)) {
    return { token: existing.token, source: "file" };
  }
  return { token: generate(), source: "generated" };
}
