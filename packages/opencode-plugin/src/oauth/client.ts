import type { OAuthServerConfig } from "../config.js";
import type { Logger } from "../logging.js";
import type { TokenSet } from "../types.js";
import { discoverOidcMetadata } from "./discovery.js";
import { openExternalUrl } from "./browser.js";
import { startLocalCallbackServer } from "./local-callback.js";
import { generatePkcePair, generateStateToken } from "./pkce.js";

interface OAuthClientOptions {
  fetchImpl?: typeof fetch;
  logger: Logger;
  timeoutMs: number;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
}

interface ResolvedEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

function isTokenValid(token?: TokenSet): boolean {
  if (!token?.accessToken) {
    return false;
  }

  if (!token.expiresAt) {
    return true;
  }

  return Date.now() + 30_000 < token.expiresAt;
}

function toTokenSet(
  payload: Record<string, unknown>,
  options?: {
    fallbackRefreshToken?: string;
    requireRefreshToken?: boolean;
  }
): TokenSet {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("OAuth token response is missing access_token");
  }

  const tokenType =
    typeof payload.token_type === "string" && payload.token_type.length > 0
      ? payload.token_type
      : "Bearer";

  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : undefined;
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : options?.fallbackRefreshToken;

  if (options?.requireRefreshToken !== false && !refreshToken) {
    throw new Error("OAuth token response is missing refresh_token");
  }

  return {
    accessToken,
    tokenType,
    refreshToken: refreshToken as string,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined
  };
}

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly onAuthorizationUrl?: (url: string) => Promise<void> | void;

  constructor(
    private readonly server: OAuthServerConfig,
    options: OAuthClientOptions
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
  }

  async ensureToken(current?: TokenSet): Promise<TokenSet> {
    if (isTokenValid(current)) {
      return current as TokenSet;
    }

    if (current?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(current.refreshToken);
        this.logger.info("oauth_refresh_success", { serverId: this.server.id });
        return refreshed;
      } catch (error) {
        this.logger.warn("oauth_refresh_failed", {
          serverId: this.server.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return this.loginInteractive();
  }

  private async resolveEndpoints(): Promise<ResolvedEndpoints> {
    if (this.server.authorizationEndpoint && this.server.tokenEndpoint) {
      return {
        authorizationEndpoint: this.server.authorizationEndpoint,
        tokenEndpoint: this.server.tokenEndpoint
      };
    }

    const metadata = await discoverOidcMetadata(
      this.server.issuer,
      this.fetchImpl,
      this.timeoutMs
    );

    return {
      authorizationEndpoint: this.server.authorizationEndpoint ?? metadata.authorization_endpoint,
      tokenEndpoint: this.server.tokenEndpoint ?? metadata.token_endpoint
    };
  }

  private async refreshToken(refreshToken: string): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.server.clientId
    });

    const response = await this.fetchImpl(endpoints.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });

    if (!response.ok) {
      throw new Error(`refresh token exchange failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const nextToken = toTokenSet(payload, {
      fallbackRefreshToken: refreshToken,
      requireRefreshToken: true
    });

    return nextToken;
  }

  private async loginInteractive(): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    const callbackServer = await startLocalCallbackServer();

    try {
      const { verifier, challenge } = generatePkcePair();
      const state = generateStateToken();
      const authorizeUrl = new URL(endpoints.authorizationEndpoint);

      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", this.server.clientId);
      authorizeUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
      authorizeUrl.searchParams.set("scope", this.server.scopes.join(" "));
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", state);

      this.logger.info("oauth_login_started", {
        serverId: this.server.id,
        issuer: this.server.issuer
      });

      if (this.onAuthorizationUrl) {
        await this.onAuthorizationUrl(authorizeUrl.toString());
      } else {
        await openExternalUrl(authorizeUrl.toString());
      }

      const callback = await callbackServer.waitForCode();
      if (callback.state !== state) {
        throw new Error("OAuth callback state mismatch");
      }

      const tokenResponse = await this.fetchImpl(endpoints.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.code,
          client_id: this.server.clientId,
          redirect_uri: callbackServer.redirectUri,
          code_verifier: verifier
        })
      });

      if (!tokenResponse.ok) {
        throw new Error(`authorization code exchange failed (${tokenResponse.status})`);
      }

      const payload = (await tokenResponse.json()) as Record<string, unknown>;
      const token = toTokenSet(payload, { requireRefreshToken: true });

      this.logger.info("oauth_login_success", {
        serverId: this.server.id,
        hasRefreshToken: true
      });

      return token;
    } catch (error) {
      this.logger.error("oauth_login_failed", {
        serverId: this.server.id,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      await callbackServer.close();
    }
  }
}
