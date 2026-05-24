import type { OAuthServerConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";

export function createSilentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

export function createServerConfig(overrides: Partial<OAuthServerConfig> = {}): OAuthServerConfig {
  return {
    id: "example-ai",
    name: "Example AI",
    issuer: "https://auth.example.com",
    baseURL: "https://api.example.com/v1",
    clientId: "opencode-client",
    scopes: ["openid", "profile", "offline_access"],
    syncIntervalMinutes: 60,
    nameOverrides: {},
    authorizationEndpoint: "https://auth.example.com/oauth/authorize",
    tokenEndpoint: "https://auth.example.com/oauth/token",
    jwksUri: "https://auth.example.com/.well-known/jwks.json",
    authFlow: "authorization_code",
    ...overrides
  };
}
