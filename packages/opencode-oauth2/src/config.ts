export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_TOKEN_EXPIRY_SKEW_MS = 30_000;

export type OAuthAuthFlow = "authorization_code" | "device_code" | "client_credentials";

export const DEFAULT_AUTH_FLOW: OAuthAuthFlow = "authorization_code";

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
}

export interface OAuth2ModelSyncConfigInput {
  servers: OAuthServerConfigInput[];
  cacheNamespace?: string;
  httpTimeoutMs?: number;
  tokenExpirySkewMs?: number;
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
}

export interface OAuth2ModelSyncConfig {
  servers: OAuthServerConfig[];
  cacheNamespace: string;
  httpTimeoutMs: number;
  tokenExpirySkewMs: number;
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

function validateAuthFlow(value: unknown, path: string): OAuthAuthFlow {
  if (value === undefined || value === null) {
    return DEFAULT_AUTH_FLOW;
  }

  if (value === "authorization_code" || value === "device_code" || value === "client_credentials") {
    return value;
  }

  throw new Error(
    `${path} must be one of "authorization_code" | "device_code" | "client_credentials" (received ${JSON.stringify(value)})`
  );
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
    authFlow
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
    tokenExpirySkewMs
  };
}
