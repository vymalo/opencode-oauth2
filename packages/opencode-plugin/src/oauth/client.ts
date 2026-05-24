import type { OAuthServerConfig } from "../config.js";
import { DEFAULT_TOKEN_EXPIRY_SKEW_MS } from "../config.js";
import type { Logger } from "../logging.js";
import type { TokenSet } from "../types.js";
import { openExternalUrl } from "./browser.js";
import { acquireTokenViaDeviceCode } from "./device-code.js";
import { discoverOidcMetadata } from "./discovery.js";
import { readResponseBodyPreview } from "./http-utils.js";
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
  authorizationEndpoint?: string;
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

  async ensureToken(
    current?: TokenSet,
    options: { interactive?: boolean } = {}
  ): Promise<TokenSet> {
    if (this.isTokenValid(current)) {
      return current as TokenSet;
    }

    // client_credentials issues no refresh token — just re-acquire from the
    // token endpoint each time the access token expires. No user interaction,
    // no refresh-token branch. Safe to run during non-interactive warmup.
    if (this.server.authFlow === "client_credentials") {
      return this.loginClientCredentials();
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

    // When called non-interactively (e.g. plugin warmup at config-hook time),
    // refuse to open a browser or block on device-code polling. Callers like
    // syncServer catch this and preserve cached state; the provider's models
    // stay empty in OpenCode until the user actually attempts a chat (which
    // calls ensureToken with the default interactive=true).
    if (options.interactive === false) {
      throw new Error(
        `interactive authentication required for server "${this.server.id}" (authFlow=${this.server.authFlow}) but called non-interactively`
      );
    }

    if (this.server.authFlow === "device_code") {
      return this.loginDeviceCode();
    }

    return this.loginInteractive();
  }

  private async loginClientCredentials(): Promise<TokenSet> {
    if (!this.server.clientSecret) {
      throw new Error("client_credentials flow requires clientSecret");
    }

    const endpoints = await this.resolveEndpoints();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.server.clientId,
      client_secret: this.server.clientSecret
    });

    if (this.server.scopes.length > 0) {
      body.set("scope", this.server.scopes.join(" "));
    }

    this.logger.info("oauth_client_credentials_started", {
      serverId: this.server.id,
      tokenEndpoint: endpoints.tokenEndpoint
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
      const bodyPreview = await readResponseBodyPreview(response, 500);
      // Log the body separately so the logger's redaction can scrub matching
      // keys (e.g. `client_secret` echoed by a verbose provider) and so the
      // body never lands in a thrown error.message that callers log verbatim.
      this.logger.error("oauth_client_credentials_failed", {
        serverId: this.server.id,
        status: response.status,
        bodyPreview: bodyPreview || undefined
      });
      throw new Error(`client_credentials token request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const token = toTokenSet(payload, { requireRefreshToken: false });

    this.logger.info("oauth_client_credentials_success", {
      serverId: this.server.id,
      hasExpiry: token.expiresAt !== undefined
    });

    return token;
  }

  /**
   * Resolve endpoints for the configured flow. Skips OIDC discovery entirely
   * when the explicit endpoints needed for the flow are all present in config
   * — discovery is unavailable on RFC 8414-only servers and on Keycloak
   * realms where the well-known doc is locked down.
   */
  private async resolveEndpoints(): Promise<ResolvedEndpoints> {
    const haveAllExplicit = this.hasExplicitEndpointsForFlow();
    if (haveAllExplicit) {
      return {
        authorizationEndpoint: this.server.authorizationEndpoint,
        tokenEndpoint: this.server.tokenEndpoint as string,
        deviceAuthorizationEndpoint: this.server.deviceAuthorizationEndpoint
      };
    }

    const metadata = await discoverOidcMetadata(this.server.issuer, this.fetchImpl, this.timeoutMs);

    const tokenEndpoint = this.server.tokenEndpoint ?? metadata.token_endpoint;
    const authorizationEndpoint =
      this.server.authorizationEndpoint ?? metadata.authorization_endpoint;
    const deviceAuthorizationEndpoint =
      this.server.deviceAuthorizationEndpoint ?? metadata.device_authorization_endpoint;

    if (this.server.authFlow === "authorization_code" && !authorizationEndpoint) {
      throw new Error(
        "authorization_code flow requires an authorization_endpoint (either configured or discovered)"
      );
    }
    if (this.server.authFlow === "device_code" && !deviceAuthorizationEndpoint) {
      throw new Error(
        "device_code flow requires a device_authorization_endpoint (either configured or discovered)"
      );
    }

    return {
      authorizationEndpoint,
      tokenEndpoint,
      deviceAuthorizationEndpoint
    };
  }

  private hasExplicitEndpointsForFlow(): boolean {
    if (!this.server.tokenEndpoint) {
      return false;
    }
    switch (this.server.authFlow) {
      case "client_credentials":
        return true;
      case "device_code":
        return Boolean(this.server.deviceAuthorizationEndpoint);
      default:
        return Boolean(this.server.authorizationEndpoint);
    }
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
    if (!endpoints.authorizationEndpoint) {
      // resolveEndpoints already guards this for authorization_code, but TS
      // sees the type as optional. Belt-and-braces.
      throw new Error(
        "authorization_code flow requires an authorization_endpoint (either configured or discovered)"
      );
    }
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
