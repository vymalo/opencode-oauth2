import { describe, expect, it } from "vitest";

import { readResponseBodyPreview, redactUrl } from "../src/oauth/http-utils.js";

describe("redactUrl", () => {
  it("strips userinfo", () => {
    expect(redactUrl("https://user:pass@api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("strips the query string and hash", () => {
    expect(redactUrl("https://api.example.com/v1/models?token=abc#frag")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("preserves the path", () => {
    expect(redactUrl("https://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("falls back gracefully for non-URL strings", () => {
    expect(redactUrl("not-a-url?query=secret")).toBe("not-a-url");
  });
});

describe("readResponseBodyPreview", () => {
  it("returns the body when within the cap", async () => {
    const response = new Response("hello", { status: 500 });
    expect(await readResponseBodyPreview(response, 100)).toBe("hello");
  });

  it("caps the returned text at maxChars", async () => {
    const big = "x".repeat(5000);
    const response = new Response(big, { status: 500 });
    const preview = await readResponseBodyPreview(response, 200);
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview.startsWith("x")).toBe(true);
  });

  it("returns an empty string when the body is empty", async () => {
    const response = new Response("", { status: 500 });
    expect(await readResponseBodyPreview(response, 100)).toBe("");
  });
});
