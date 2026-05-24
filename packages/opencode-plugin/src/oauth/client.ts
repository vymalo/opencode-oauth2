import type { OAuthServerConfig } from "../config.js";
import { DEFAULT_TOKEN_EXPIRY_SKEW_MS } from "../config.js";
import type { Logger } from "../logging.js";
import type { TokenSet } from "../types.js";
import { openExternalUrl } from "./browser.js";
import { acquireTokenViaDeviceCode } from "./device-code.js";
import { discoverOidcMetadata } from "./discovery.js";
import { startLocalCallbackServer } from "./local-callback.js";
import { generatePkcePair, generateStateToken } from "./pkce.js";

interface OAuthClientOptions {
  fetchImpl?: typeof fetch;
  logger: Logger;
  timeoutMs: number;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  tokenExpirySkewMs?: number;
}

interface ResolvedEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
}

export function toTokenSet(
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
  private readonly tokenExpirySkewMs: number;

  constructor(
    private readonly server: OAuthServerConfig,
    options: OAuthClientOptions
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.tokenExpirySkewMs =
      typeof options.tokenExpirySkewMs === "number" &&
      Number.isFinite(options.tokenExpirySkewMs) &&
      options.tokenExpirySkewMs > 0
        ? options.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS;
  }

  private isTokenValid(token?: TokenSet): boolean {
    if (!token?.accessToken) {
      return false;
    }

    if (!token.expiresAt) {
      return true;
    }

    return Date.now() + this.tokenExpirySkewMs < token.expiresAt;
  }

  async ensureToken(current?: TokenSet): Promise<TokenSet> {
    if (this.isTokenValid(current)) {
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

    if (this.server.authFlow === "device_code") {
      return this.loginDeviceCode();
    }

    return this.loginInteractive();
  }

  private async resolveEndpoints(): Promise<ResolvedEndpoints> {
    if (
      this.server.authorizationEndpoint &&
      this.server.tokenEndpoint &&
      (this.server.authFlow !== "device_code" || this.server.deviceAuthorizationEndpoint)
    ) {
      return {
        authorizationEndpoint: this.server.authorizationEndpoint,
        tokenEndpoint: this.server.tokenEndpoint,
        deviceAuthorizationEndpoint: this.server.deviceAuthorizationEndpoint
      };
    }

    const metadata = await discoverOidcMetadata(this.server.issuer, this.fetchImpl, this.timeoutMs);

    const deviceAuthorizationEndpoint =
      this.server.deviceAuthorizationEndpoint ?? metadata.device_authorization_endpoint;

    if (this.server.authFlow === "device_code" && !deviceAuthorizationEndpoint) {
      throw new Error(
        "device_code flow requires a device_authorization_endpoint (either configured or discovered)"
      );
    }

    return {
      authorizationEndpoint: this.server.authorizationEndpoint ?? metadata.authorization_endpoint,
      tokenEndpoint: this.server.tokenEndpoint ?? metadata.token_endpoint,
      deviceAuthorizationEndpoint
    };
  }

  private async refreshToken(refreshToken: string): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.server.clientId
    });

    if (this.server.clientSecret) {
      body.set("client_secret", this.server.clientSecret);
    }

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

  private async loginDeviceCode(): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    if (!endpoints.deviceAuthorizationEndpoint) {
      throw new Error(
        "device_code flow requires a device_authorization_endpoint (either configured or discovered)"
      );
    }

    return acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: endpoints.deviceAuthorizationEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: this.server.clientId,
      clientSecret: this.server.clientSecret,
      scopes: this.server.scopes,
      serverId: this.server.id,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs
    });
  }

  private async loginInteractive(): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    const callbackServer = await startLocalCallbackServer(
      "/oauth2/callback",
      this.server.redirectPort
    );

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
        issuer: this.server.issuer,
        authorizationEndpoint: `${authorizeUrl.origin}${authorizeUrl.pathname}`
      });

      if (this.onAuthorizationUrl) {
        await this.onAuthorizationUrl(authorizeUrl.toString());
      } else {
        try {
          await openExternalUrl(authorizeUrl.toString());
        } catch (error) {
          this.logger.warn("oauth_open_browser_failed", {
            serverId: this.server.id,
            error: error instanceof Error ? error.message : String(error)
          });
          // Write the URL to stderr directly so the terminal user can copy-paste
          // it. Bypasses the structured logger to avoid leaking the `state`
          // nonce (and other query params) into centralized log aggregation,
          // which would enable login-CSRF via a forged localhost callback.
          process.stderr.write(
            `\n[lightbridge-opencode] open this URL to authenticate (${this.server.id}):\n${authorizeUrl.toString()}\n\n`
          );
        }
      }

      const callback = await callbackServer.waitForCode();
      if (callback.state !== state) {
        throw new Error("OAuth callback state mismatch");
      }

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        client_id: this.server.clientId,
        redirect_uri: callbackServer.redirectUri,
        code_verifier: verifier
      });

      if (this.server.clientSecret) {
        tokenBody.set("client_secret", this.server.clientSecret);
      }

      const tokenResponse = await this.fetchImpl(endpoints.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: tokenBody
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
