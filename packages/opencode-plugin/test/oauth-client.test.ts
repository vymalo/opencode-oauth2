import { describe, expect, it } from "vitest";

import { OAuthClient } from "../src/oauth/client.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }

  return new URLSearchParams(String(body ?? ""));
}

describe("OAuthClient token lifecycle", () => {
  it("reuses a valid token without network calls", async () => {
    const client = new OAuthClient(createServerConfig(), {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for valid token");
      }
    });

    const token = {
      accessToken: "valid-access",
      tokenType: "Bearer",
      refreshToken: "valid-refresh",
      expiresAt: Date.now() + 10 * 60_000
    };

    await expect(client.ensureToken(token)).resolves.toEqual(token);
  });

  it("refreshes expired tokens and keeps previous refresh token if endpoint omits it", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(server.tokenEndpoint);

        const body = parseFormBody(init);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token");

        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            token_type: "Bearer",
            expires_in: 3600
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const token = await client.ensureToken({
      accessToken: "old-access-token",
      tokenType: "Bearer",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() - 1000
    });

    expect(token.accessToken).toBe("new-access-token");
    expect(token.refreshToken).toBe("old-refresh-token");
  });

  it("completes interactive login and returns refresh token", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(server.tokenEndpoint);

        const body = parseFormBody(init);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("auth-code-123");

        return new Response(
          JSON.stringify({
            access_token: "interactive-access",
            refresh_token: "interactive-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      },
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");

        expect(parsed.searchParams.get("response_type")).toBe("code");
        expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
        expect(redirectUri).toBeTruthy();
        expect(state).toBeTruthy();

        await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
      }
    });

    const token = await client.ensureToken();
    expect(token.accessToken).toBe("interactive-access");
    expect(token.refreshToken).toBe("interactive-refresh");
  });

  it("fails interactive login when provider does not return a refresh token", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        return new Response(
          JSON.stringify({
            access_token: "access-only",
            token_type: "Bearer"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      },
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");

        await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
      }
    });

    await expect(client.ensureToken()).rejects.toThrow(/refresh_token/i);
  });
});
