import { describe, expect, it } from "vitest";

import { fetchModels } from "../src/model-discovery.js";
import type { TokenSet } from "../src/types.js";

const token: TokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  refreshToken: "test-refresh"
};

describe("fetchModels error reporting", () => {
  it("includes the response body in the error when the API rejects the request", async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"insufficient_scope","detail":"missing access:foo"}', {
        status: 403,
        headers: { "Content-Type": "application/json" }
      })) as typeof fetch;

    await expect(fetchModels("https://api.example.com/v1", token, { fetchImpl })).rejects.toThrow(
      /403.*insufficient_scope/
    );
  });

  it("truncates very large error bodies", async () => {
    const longBody = "X".repeat(2000);
    const fetchImpl = (async () => new Response(longBody, { status: 500 })) as typeof fetch;

    await expect(fetchModels("https://api.example.com/v1", token, { fetchImpl })).rejects.toThrow(
      /500.*XXXX/
    );

    try {
      await fetchModels("https://api.example.com/v1", token, { fetchImpl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 500-char body cap + the rest of the formatted error
      expect(message.length).toBeLessThan(700);
    }
  });
});
