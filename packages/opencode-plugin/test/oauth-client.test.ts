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

  it("does not log the authorize URL (or state nonce) into structured logs during interactive login", async () => {
    const server = createServerConfig();

    type Entry = { level: string; event: string; fields?: Record<string, unknown> };
    const entries: Entry[] = [];
    const recordingLogger = {
      debug(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "debug", event, fields });
      },
      info(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "info", event, fields });
      },
      warn(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "warn", event, fields });
      },
      error(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "error", event, fields });
      }
    };

    let observedState: string | undefined;

    const client = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        observedState = parsed.searchParams.get("state") ?? undefined;
        const redirectUri = parsed.searchParams.get("redirect_uri");
        await fetch(`${redirectUri}?code=c&state=${observedState}`);
      }
    });

    await client.ensureToken();

    expect(observedState).toBeTruthy();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(observedState as string);
    expect(serialized).not.toMatch(/code_challenge=/);
    expect(serialized).not.toMatch(/redirect_uri=/);
  });

  it("treats a soon-to-expire token as invalid when skew exceeds remaining lifetime", async () => {
    const server = createServerConfig();

    let fetchCalls = 0;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      tokenExpirySkewMs: 30_000,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access",
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
      accessToken: "current",
      tokenType: "Bearer",
      refreshToken: "refresh",
      expiresAt: Date.now() + 10_000
    });

    expect(fetchCalls).toBe(1);
    expect(token.accessToken).toBe("refreshed-access");
  });

  it("treats a soon-to-expire token as valid when skew is below remaining lifetime", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      tokenExpirySkewMs: 5_000,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for valid token");
      }
    });

    const expiresAt = Date.now() + 10_000;
    const token = await client.ensureToken({
      accessToken: "current",
      tokenType: "Bearer",
      refreshToken: "refresh",
      expiresAt
    });

    expect(token.accessToken).toBe("current");
    expect(token.expiresAt).toBe(expiresAt);
  });

  it("includes client_secret in authorization-code token exchange and refresh requests", async () => {
    const server = createServerConfig({ clientSecret: "super-secret-shh" });

    // First call: refresh
    let lastBody: URLSearchParams | undefined;
    const refreshClient = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        lastBody = parseFormBody(init);
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    await refreshClient.ensureToken({
      accessToken: "old",
      tokenType: "Bearer",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000
    });

    expect(lastBody?.get("grant_type")).toBe("refresh_token");
    expect(lastBody?.get("client_secret")).toBe("super-secret-shh");

    // Second call: authorization_code exchange
    lastBody = undefined;
    const exchangeClient = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        lastBody = parseFormBody(init);
        return new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
      }
    });

    await exchangeClient.ensureToken();
    expect(lastBody?.get("grant_type")).toBe("authorization_code");
    expect(lastBody?.get("client_secret")).toBe("super-secret-shh");
    expect(lastBody?.get("code_verifier")).toBeTruthy();
  });

  it("does not leak clientSecret into structured logs on success or failure", async () => {
    const server = createServerConfig({ clientSecret: "leaky-secret-9000" });

    type Entry = { level: string; event: string; fields?: Record<string, unknown> };
    const entries: Entry[] = [];
    const recordingLogger = {
      debug(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "debug", event, fields });
      },
      info(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "info", event, fields });
      },
      warn(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "warn", event, fields });
      },
      error(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "error", event, fields });
      }
    };

    // Success path: authorization_code exchange.
    const successClient = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirectUri}?code=c&state=${state}`);
      }
    });

    await successClient.ensureToken();

    // Failure path: refresh fails with a 400, then the auth-code exchange
    // also fails. The server might echo the secret-bearing body in some
    // configurations; we must not include the secret in our own error logs
    // regardless.
    const failClient = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response("bad request", {
          status: 400,
          headers: { "Content-Type": "text/plain" }
        }),
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirectUri}?code=c&state=${state}`);
      }
    });

    await expect(
      failClient.ensureToken({
        accessToken: "x",
        tokenType: "Bearer",
        refreshToken: "expired",
        expiresAt: Date.now() - 1000
      })
    ).rejects.toThrow();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("leaky-secret-9000");
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
