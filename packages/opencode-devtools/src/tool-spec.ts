import type { JsonInput, ToolGroup } from "./schema.js";
import type { ResolvedDevtoolsOptions } from "./types.js";

/**
 * Execution context handed to every tool handler. The clock, randomness and
 * fetch are injected (not imported) so the deterministic groups stay unit-
 * testable: a test pins `now`/`randomBytes` and asserts exact output, and the
 * `http` group runs against a fake `fetchImpl` with no network.
 */
export interface ToolContext {
  options: ResolvedDevtoolsOptions;
  /** Current time. Default `() => new Date()`. */
  now: () => Date;
  /** Cryptographically-strong random bytes. Default `node:crypto.randomBytes`. */
  randomBytes: (size: number) => Buffer;
  /** Fetch implementation for the `http` group. Default the global `fetch`. */
  fetchImpl: typeof fetch;
}

/**
 * Adapter-neutral result of a tool call. `text` is always the self-sufficient
 * human/agent-readable output; `data` (json only) carries optional structured
 * metadata the OpenCode adapter surfaces as `metadata`. There is no image
 * variant — unlike the browser plugin, devtools tools return text/json only.
 */
export type NeutralResult =
  | { kind: "text"; text: string }
  | { kind: "json"; text: string; data: unknown };

export interface ToolSpec {
  name: string;
  group: ToolGroup;
  description: string;
  input: JsonInput;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext
  ) => NeutralResult | Promise<NeutralResult>;
}

// ─── result builders ─────────────────────────────────────────────────────────
export const text = (t: string): NeutralResult => ({ kind: "text", text: t });
export const json = (data: unknown, t: string): NeutralResult => ({ kind: "json", data, text: t });

// ─── arg coercion (args are pre-validated by the adapter's schema) ───────────
export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`"${key}" must be a string`);
  }
  return v;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function reqNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(`"${key}" must be a number`);
  }
  return v;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}
