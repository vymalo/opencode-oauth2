import { describe, expect, it } from "vitest";

import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  validateConfig
} from "../src/config.js";

describe("validateConfig", () => {
  it("applies defaults and normalizes server names", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid", "offline_access"]
        }
      ]
    });

    expect(result.cacheNamespace).toBe("oauth2-model-sync");
    expect(result.httpTimeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(result.servers[0]?.name).toBe("server-1");
    expect(result.servers[0]?.syncIntervalMinutes).toBe(DEFAULT_SYNC_INTERVAL_MINUTES);
    expect(result.servers[0]?.nameOverrides).toEqual({});
  });

  it("rejects duplicate server IDs", () => {
    expect(() =>
      validateConfig({
        servers: [
          {
            id: "dup",
            issuer: "https://auth-a.example.com",
            baseURL: "https://api-a.example.com/v1",
            clientId: "client-a",
            scopes: ["openid"]
          },
          {
            id: "dup",
            issuer: "https://auth-b.example.com",
            baseURL: "https://api-b.example.com/v1",
            clientId: "client-b",
            scopes: ["openid"]
          }
        ]
      })
    ).toThrow(/duplicate server id/i);
  });

  it("defaults tokenExpirySkewMs and treats omitted redirectPort as undefined", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid"]
        }
      ]
    });

    expect(result.tokenExpirySkewMs).toBe(DEFAULT_TOKEN_EXPIRY_SKEW_MS);
    expect(result.servers[0]?.redirectPort).toBeUndefined();
  });

  it("accepts a valid redirectPort and tokenExpirySkewMs", () => {
    const result = validateConfig({
      tokenExpirySkewMs: 5000,
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid"],
          redirectPort: 53682
        }
      ]
    });

    expect(result.tokenExpirySkewMs).toBe(5000);
    expect(result.servers[0]?.redirectPort).toBe(53682);
  });

  it("rejects a negative or out-of-range redirectPort", () => {
    expect(() =>
      validateConfig({
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: ["openid"],
            redirectPort: -1
          }
        ]
      })
    ).toThrow(/redirectPort/);

    expect(() =>
      validateConfig({
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: ["openid"],
            redirectPort: 70000
          }
        ]
      })
    ).toThrow(/redirectPort/);

    expect(() =>
      validateConfig({
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: ["openid"],
            redirectPort: 1234.5
          }
        ]
      })
    ).toThrow(/redirectPort/);
  });

  it("rejects a non-positive tokenExpirySkewMs", () => {
    expect(() =>
      validateConfig({
        tokenExpirySkewMs: 0,
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: ["openid"]
          }
        ]
      })
    ).toThrow(/tokenExpirySkewMs/);

    expect(() =>
      validateConfig({
        tokenExpirySkewMs: -100,
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: ["openid"]
          }
        ]
      })
    ).toThrow(/tokenExpirySkewMs/);
  });

  it("accepts an optional clientSecret on a server", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          clientSecret: "shh-it-is-a-secret",
          scopes: ["openid"]
        }
      ]
    });

    expect(result.servers[0]?.clientSecret).toBe("shh-it-is-a-secret");
  });

  it("treats an omitted clientSecret as undefined", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid"]
        }
      ]
    });

    expect(result.servers[0]?.clientSecret).toBeUndefined();
  });

  it("rejects an empty-string clientSecret", () => {
    expect(() =>
      validateConfig({
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            clientSecret: "",
            scopes: ["openid"]
          }
        ]
      })
    ).toThrow(/clientSecret/);
  });

  it("defaults authFlow to authorization_code", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid"]
        }
      ]
    });

    expect(result.servers[0]?.authFlow).toBe("authorization_code");
  });

  it("accepts authFlow: device_code", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid"],
          authFlow: "device_code"
        }
      ]
    });

    expect(result.servers[0]?.authFlow).toBe("device_code");
  });

  it("rejects an unknown authFlow value", () => {
    expect(() =>
      validateConfig({
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: ["openid"],
            // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
            authFlow: "client_credentials" as any
          }
        ]
      })
    ).toThrow(/authFlow/);
  });

  it("accepts an optional deviceAuthorizationEndpoint override", () => {
    const result = validateConfig({
      servers: [
        {
          id: "server-1",
          issuer: "https://auth.example.com",
          baseURL: "https://api.example.com/v1",
          clientId: "client-id",
          scopes: ["openid"],
          deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
        }
      ]
    });

    expect(result.servers[0]?.deviceAuthorizationEndpoint).toBe(
      "https://auth.example.com/device/authorize"
    );
  });

  it("rejects invalid scopes", () => {
    expect(() =>
      validateConfig({
        servers: [
          {
            id: "invalid-scopes",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "client-id",
            scopes: []
          }
        ]
      })
    ).toThrow(/scopes/i);
  });
});
