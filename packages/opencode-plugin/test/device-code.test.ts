import { describe, expect, it } from "vitest";

import { acquireTokenViaDeviceCode } from "../src/oauth/device-code.js";
import { createSilentLogger } from "./helpers.js";

interface FetchCall {
  url: string;
  body: URLSearchParams;
}

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(String(body ?? ""));
}

function recordingFetch(responses: Array<() => Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: parseFormBody(init) });
    const producer = responses[i++];
    if (!producer) {
      throw new Error(`unexpected fetch call (#${i})`);
    }
    return producer();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe("acquireTokenViaDeviceCode", () => {
  it("happy path: requests device code, polls past authorization_pending, returns tokens", async () => {
    const sleeps: number[] = [];
    const { fetch: fetchImpl, calls } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            verification_uri_complete: "https://auth.example.com/device?user_code=WDJB-MJHT",
            expires_in: 600,
            interval: 2
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
      () =>
        new Response(
          JSON.stringify({
            access_token: "device-access",
            refresh_token: "device-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    const token = await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      scopes: ["openid", "offline_access"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    expect(token.accessToken).toBe("device-access");
    expect(token.refreshToken).toBe("device-refresh");

    // First call: device authorization request
    expect(calls[0].url).toBe("https://auth.example.com/device/authorize");
    expect(calls[0].body.get("client_id")).toBe("device-client");
    expect(calls[0].body.get("scope")).toBe("openid offline_access");

    // Second call: poll #1 (authorization_pending)
    expect(calls[1].url).toBe("https://auth.example.com/oauth/token");
    expect(calls[1].body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(calls[1].body.get("device_code")).toBe("dev-code-abc");
    expect(calls[1].body.get("client_id")).toBe("device-client");

    // Third call: poll #2 (success)
    expect(calls[2].url).toBe("https://auth.example.com/oauth/token");

    // Sleeps respect the server-provided interval of 2s
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBe(2000);
  });

  it("increases polling interval by 5s on slow_down", async () => {
    const sleeps: number[] = [];
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 3
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "slow_down" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
      () =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
      () =>
        new Response(
          JSON.stringify({
            access_token: "device-access",
            refresh_token: "device-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      scopes: ["openid", "offline_access"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    // First poll: 3s (server-provided interval)
    expect(sleeps[0]).toBe(3000);
    // After slow_down: interval bumped to 8s
    expect(sleeps[1]).toBe(8000);
    // After authorization_pending: still 8s
    expect(sleeps[2]).toBe(8000);
  });

  it("throws on expired_token error from token endpoint", async () => {
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "expired_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {}
      })
    ).rejects.toThrow(/expired/i);
  });

  it("throws on access_denied error from token endpoint", async () => {
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "access_denied" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {}
      })
    ).rejects.toThrow(/denied/i);
  });

  it("throws when success response is missing refresh_token", async () => {
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "no-refresh-token-here",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {}
      })
    ).rejects.toThrow(/refresh_token/i);
  });

  it("includes client_secret in device-auth and poll requests; never logs it", async () => {
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

    const { fetch: fetchImpl, calls } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      clientSecret: "device-secret-shhh",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: recordingLogger,
      fetchImpl,
      timeoutMs: 5000,
      sleep: async () => {}
    });

    expect(calls[0].body.get("client_secret")).toBe("device-secret-shhh");
    expect(calls[1].body.get("client_secret")).toBe("device-secret-shhh");

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("device-secret-shhh");
  });

  it("expires before user authorizes when deadline elapses", async () => {
    let nowValue = 1_000_000;
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 2,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {
          // advance clock past the deadline
          nowValue += 5_000;
        },
        now: () => nowValue
      })
    ).rejects.toThrow(/expired/i);
  });
});
