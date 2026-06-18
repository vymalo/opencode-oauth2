import type { ToolGroup } from "./schema.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type { ToolGroup } from "./schema.js";

/**
 * Per-plugin configuration, supplied as the second argument to the plugin
 * factory by OpenCode (the `[name, options]` tuple form in `plugin`). All
 * fields are optional; see DEFAULTS in opencode.ts for the resolved values.
 */
export interface DevtoolsPluginOptions {
  /** Master switch. When false no tools are registered. */
  enabled?: boolean;
  /**
   * Which tool groups to register. The five deterministic, offline groups
   * (`math`, `codec`, `crypto`, `datetime`, `convert`) are on by default;
   * `http` performs network egress and is **opt-in** — add it explicitly to
   * enable it. Per-agent control is also possible via OpenCode's tool
   * allow/deny on the `math_* / codec_* / …` names.
   */
  groups?: ToolGroup[];
  /** Options for the opt-in `http` group. */
  http?: HttpOptions;
}

export interface HttpOptions {
  /**
   * Allow requests to loopback / private / link-local hosts (incl. the cloud
   * metadata IP `169.254.169.254`). Default `false` — the SSRF guard rejects
   * them. Turn on only when you intend the model to reach internal services.
   */
  allowPrivateNetwork?: boolean;
  /** Per-request timeout in ms before the call aborts. Default 30000. */
  timeoutMs?: number;
}

/** Fully-resolved options with defaults applied. */
export interface ResolvedDevtoolsOptions {
  enabled: boolean;
  groups: ToolGroup[];
  http: Required<HttpOptions>;
}
