import type { LogLevel } from "./logging.js";

export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_TOKEN_EXPIRY_SKEW_MS = 30_000;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export type OAuthAuthFlow =
  | "authorization_code"
  | "device_code"
  | "client_credentials"
  | "jwt_bearer"
  | "token_exchange";

export const DEFAULT_AUTH_FLOW: OAuthAuthFlow = "authorization_code";

/**
 * Where to read the platform-supplied JWT that the plugin presents as the
 * subject token / assertion for the `jwt_bearer` and `token_exchange` flows.
 *
 * - `github_actions` — fetches the OIDC token from the GitHub Actions runtime
 *   via `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`,
 *   with the workflow-declared `audience`. The `id-token: write` permission
 *   is required on the job.
 * - `kubernetes_sa` — reads a projected service-account token from the pod
 *   filesystem. Default path `/var/run/secrets/tokens/oauth2/token`; mount a
 *   `projected.sources.serviceAccountToken` volume with the OIDC issuer as
 *   the audience.
 * - `file` — reads any JWT from disk. Useful when an external sidecar
 *   refreshes the token to a fixed path.
 * - `env` — reads the JWT from a named environment variable. Mostly useful
 *   for tests and ad-hoc shells.
 */
export type SubjectTokenSource =
  | { type: "github_actions"; audience: string }
  | { type: "kubernetes_sa"; tokenPath?: string }
  | { type: "file"; path: string }
  | { type: "env"; var: string };

export const DEFAULT_K8S_SA_TOKEN_PATH = "/var/run/secrets/tokens/oauth2/token";

export interface OAuthServerConfigInput {
  id: string;
  name?: string;
  issuer: string;
  baseURL: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  syncIntervalMinutes?: number;
  nameOverrides?: Record<string, string>;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri?: string;
  redirectPort?: number;
  authFlow?: OAuthAuthFlow;
  /**
   * Required for `jwt_bearer` and `token_exchange`. Tells the plugin where to
   * read the platform JWT it should present as the subject token.
   */
  subjectTokenSource?: SubjectTokenSource;
  /**
   * Optional `audience` parameter for the `token_exchange` grant — the
   * intended recipient of the resulting access token. Set this when the
   * OAuth server expects an explicit audience claim distinct from the
   * issuer.
   */
  tokenExchangeAudience?: string;
}

export interface OAuth2ModelSyncConfigInput {
  servers: OAuthServerConfigInput[];
  cacheNamespace?: string;
  httpTimeoutMs?: number;
  tokenExpirySkewMs?: number;
  /**
   * Minimum log level the plugin emits. Lower-priority records are dropped.
   * One of `"debug" | "info" | "warn" | "error"`. Defaults to `"info"`.
   */
  logLevel?: LogLevel;
}

export interface OAuthServerConfig {
  id: string;
  name: string;
  issuer: string;
  baseURL: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  syncIntervalMinutes: number;
  nameOverrides: Record<string, string>;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri?: string;
  redirectPort?: number;
  authFlow: OAuthAuthFlow;
  subjectTokenSource?: SubjectTokenSource;
  tokenExchangeAudience?: string;
}

export interface OAuth2ModelSyncConfig {
  servers: OAuthServerConfig[];
  cacheNamespace: string;
  httpTimeoutMs: number;
  tokenExpirySkewMs: number;
  logLevel: LogLevel;
}

function ensureString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function ensureStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of strings`);
  }

  return value.map((item, index) => ensureString(item, `${path}[${index}]`));
}

function validateRedirectPort(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value >= 65536) {
    throw new Error(`${path} must be a positive integer less than 65536`);
  }

  return value;
}

function validateLogLevel(value: unknown, path: string): LogLevel {
  if (value === undefined || value === null) {
    return DEFAULT_LOG_LEVEL;
  }

  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }

  throw new Error(
    `${path} must be one of "debug" | "info" | "warn" | "error" (received ${JSON.stringify(value)})`
  );
}

function validateAuthFlow(value: unknown, path: string): OAuthAuthFlow {
  if (value === undefined || value === null) {
    return DEFAULT_AUTH_FLOW;
  }

  if (
    value === "authorization_code" ||
    value === "device_code" ||
    value === "client_credentials" ||
    value === "jwt_bearer" ||
    value === "token_exchange"
  ) {
    return value;
  }

  throw new Error(
    `${path} must be one of "authorization_code" | "device_code" | "client_credentials" | "jwt_bearer" | "token_exchange" (received ${JSON.stringify(value)})`
  );
}

function validateSubjectTokenSource(value: unknown, path: string): SubjectTokenSource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  switch (type) {
    case "github_actions": {
      const audience = record.audience;
      if (typeof audience !== "string" || audience.trim().length === 0) {
        throw new Error(
          `${path}.audience must be a non-empty string when type is "github_actions"`
        );
      }
      return { type: "github_actions", audience: audience.trim() };
    }
    case "kubernetes_sa": {
      const tokenPath = record.tokenPath;
      if (tokenPath !== undefined && tokenPath !== null) {
        if (typeof tokenPath !== "string" || tokenPath.trim().length === 0) {
          throw new Error(`${path}.tokenPath must be a non-empty string when provided`);
        }
        return { type: "kubernetes_sa", tokenPath: tokenPath.trim() };
      }
      return { type: "kubernetes_sa" };
    }
    case "file": {
      const filePath = record.path;
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error(`${path}.path must be a non-empty string when type is "file"`);
      }
      return { type: "file", path: filePath.trim() };
    }
    case "env": {
      const varName = record.var;
      if (typeof varName !== "string" || varName.trim().length === 0) {
        throw new Error(`${path}.var must be a non-empty string when type is "env"`);
      }
      return { type: "env", var: varName.trim() };
    }
    default:
      throw new Error(
        `${path}.type must be one of "github_actions" | "kubernetes_sa" | "file" | "env" (received ${JSON.stringify(type)})`
      );
  }
}

function normalizeServerConfig(input: OAuthServerConfigInput, index: number): OAuthServerConfig {
  const path = `servers[${index}]`;

  const id = ensureString(input.id, `${path}.id`);
  const name = input.name && input.name.trim().length > 0 ? input.name.trim() : id;
  const issuer = ensureString(input.issuer, `${path}.issuer`);
  const baseURL = ensureString(input.baseURL, `${path}.baseURL`);
  const clientId = ensureString(input.clientId, `${path}.clientId`);
  const scopes = ensureStringArray(input.scopes, `${path}.scopes`);

  const syncIntervalMinutes =
    typeof input.syncIntervalMinutes === "number" &&
    Number.isFinite(input.syncIntervalMinutes) &&
    input.syncIntervalMinutes > 0
      ? input.syncIntervalMinutes
      : DEFAULT_SYNC_INTERVAL_MINUTES;

  const redirectPort = validateRedirectPort(input.redirectPort, `${path}.redirectPort`);
  const authFlow = validateAuthFlow(input.authFlow, `${path}.authFlow`);
  const subjectTokenSource = validateSubjectTokenSource(
    input.subjectTokenSource,
    `${path}.subjectTokenSource`
  );

  let clientSecret: string | undefined;
  if (input.clientSecret !== undefined && input.clientSecret !== null) {
    if (typeof input.clientSecret !== "string" || input.clientSecret.length === 0) {
      throw new Error(`${path}.clientSecret must be a non-empty string when provided`);
    }
    clientSecret = input.clientSecret;
  }

  if (authFlow === "client_credentials" && !clientSecret) {
    throw new Error(`${path}.clientSecret is required when authFlow is "client_credentials"`);
  }

  if ((authFlow === "jwt_bearer" || authFlow === "token_exchange") && !subjectTokenSource) {
    throw new Error(
      `${path}.subjectTokenSource is required when authFlow is "${authFlow}" — set it to {type: "github_actions" | "kubernetes_sa" | "file" | "env", ...}`
    );
  }

  let tokenExchangeAudience: string | undefined;
  if (input.tokenExchangeAudience !== undefined && input.tokenExchangeAudience !== null) {
    if (
      typeof input.tokenExchangeAudience !== "string" ||
      input.tokenExchangeAudience.trim().length === 0
    ) {
      throw new Error(`${path}.tokenExchangeAudience must be a non-empty string when provided`);
    }
    tokenExchangeAudience = input.tokenExchangeAudience.trim();
  }

  return {
    id,
    name,
    issuer,
    baseURL,
    clientId,
    clientSecret,
    scopes,
    syncIntervalMinutes,
    nameOverrides: input.nameOverrides ?? {},
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint,
    jwksUri: input.jwksUri,
    redirectPort,
    authFlow,
    subjectTokenSource,
    tokenExchangeAudience
  };
}

export function validateConfig(input: OAuth2ModelSyncConfigInput): OAuth2ModelSyncConfig {
  if (!input || typeof input !== "object") {
    throw new Error("plugin config must be an object");
  }

  if (!Array.isArray(input.servers) || input.servers.length === 0) {
    throw new Error("servers must be a non-empty array");
  }

  const normalizedServers = input.servers.map(normalizeServerConfig);
  const ids = new Set<string>();

  for (const server of normalizedServers) {
    if (ids.has(server.id)) {
      throw new Error(`duplicate server id detected: ${server.id}`);
    }
    ids.add(server.id);
  }

  let tokenExpirySkewMs = DEFAULT_TOKEN_EXPIRY_SKEW_MS;
  if (input.tokenExpirySkewMs !== undefined && input.tokenExpirySkewMs !== null) {
    if (
      typeof input.tokenExpirySkewMs !== "number" ||
      !Number.isFinite(input.tokenExpirySkewMs) ||
      input.tokenExpirySkewMs <= 0
    ) {
      throw new Error("tokenExpirySkewMs must be a positive number");
    }
    tokenExpirySkewMs = input.tokenExpirySkewMs;
  }

  return {
    servers: normalizedServers,
    cacheNamespace:
      typeof input.cacheNamespace === "string" && input.cacheNamespace.trim().length > 0
        ? input.cacheNamespace.trim()
        : "oauth2-model-sync",
    httpTimeoutMs:
      typeof input.httpTimeoutMs === "number" &&
      Number.isFinite(input.httpTimeoutMs) &&
      input.httpTimeoutMs > 0
        ? input.httpTimeoutMs
        : DEFAULT_HTTP_TIMEOUT_MS,
    tokenExpirySkewMs,
    logLevel: validateLogLevel(input.logLevel, "logLevel")
  };
}
