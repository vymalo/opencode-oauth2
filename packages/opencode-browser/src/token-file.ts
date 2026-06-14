import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Per-user state file so multiple adapters (plugin + MCP server) on one machine
 * share a bridge token without the operator wiring one up. It lives in the
 * persistent per-OS app-data dir (NOT the temp dir), so a generated token
 * survives reboots — you paste it into the extension once, not every session.
 * Best-effort: a simultaneous cold start can race (each generates its own token
 * before either writes); set an explicit token if you need that guaranteed.
 */
function resolveStateRoot(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

const FILE = join(resolveStateRoot(), "opencode-browser", "bridge.json");

// ≤0.7.x kept this in the temp dir, where the OS clears it on reboot (so the
// token kept changing). Read it once as a fallback so upgrading doesn't force a
// re-paste; the next write migrates it to the persistent location above.
const LEGACY_FILE = join(tmpdir(), "opencode-browser-bridge.json");

export interface BridgeFile {
  port?: number;
  token?: string;
}

function readFileAt(path: string): BridgeFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BridgeFile;
  } catch {
    return null;
  }
}

export function readBridgeFile(): BridgeFile | null {
  return readFileAt(FILE) ?? readFileAt(LEGACY_FILE);
}

export function writeBridgeFile(port: number, token: string): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
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
