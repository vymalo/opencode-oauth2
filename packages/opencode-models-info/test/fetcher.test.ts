import { describe, expect, it, vi } from "vitest";

import { fetchOpenRouterModels } from "../src/fetcher.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

describe("fetchOpenRouterModels", () => {
  it("returns parsed models from a `{data: []}` envelope and captures ETag", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [{ id: "a" }, { id: "b" }] }, { status: 200, headers: { etag: "v1" } })
      );

    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.status).toBe("ok");
    expect(result.models?.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.etag).toBe("v1");
  });

  it("accepts a bare top-level array response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: "a" }], { status: 200 }));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("ok");
    expect(result.models?.map((m) => m.id)).toEqual(["a"]);
  });

  it("filters out entries without a string `id`", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [{ id: "a" }, { id: 42 }, { name: "no id" }, { id: "b" }] })
      );
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.models?.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns an error result on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/500/);
  });

  it("returns not-modified and echoes the supplied etag on 304", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      etag: "v1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("not-modified");
    expect(result.etag).toBe("v1");
  });

  it("sends If-None-Match when an etag is provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      etag: "v1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe("v1");
  });

  it("merges caller-supplied headers without dropping defaults", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      headers: { authorization: "Bearer t", "x-tenant": "t1" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.accept).toBe("application/json");
    expect(headers.authorization).toBe("Bearer t");
    expect(headers["x-tenant"]).toBe("t1");
  });

  it("treats a non-empty input that filters down to empty as a parse error", async () => {
    // Catalog with two malformed entries — no `id: string` anywhere. We
    // should NOT report this as a successful empty fetch (that would
    // overwrite a previously good cache).
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: 42 }, { name: "no id" }] }));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/unexpected response shape/);
  });

  it("accepts a legitimately empty catalog as a successful (empty) response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("ok");
    expect(result.models).toEqual([]);
  });

  it("returns an error result instead of throwing on malformed JSON shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/unexpected response shape/);
  });

  it("returns an error result instead of throwing when fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("network down");
  });

  it("aborts via AbortController when the timeout fires", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });

    const result = await fetchOpenRouterModels({
      url: "https://x.test/models",
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/abort/i);
  });
});
