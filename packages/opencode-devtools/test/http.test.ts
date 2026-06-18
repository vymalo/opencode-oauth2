import { describe, expect, it, vi } from "vitest";

import { isBlockedHost } from "../src/groups/http.js";
import { ctx, run } from "./helpers.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

describe("http group — SSRF guard", () => {
  it("flags loopback / private / link-local hosts", () => {
    for (const h of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.5.5",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "fe80::1",
      "fe81::1", // fe80::/10 spans fe80–febf, not just fe80
      "febf::1",
      "ff02::1" // multicast
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const h of ["example.com", "8.8.8.8", "172.15.0.1", "192.169.0.1"]) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });

  it("blocks requests to private hosts by default", async () => {
    const fetchImpl = vi.fn();
    await expect(
      run("http_request", { url: "http://169.254.169.254/latest/meta-data" }, ctx({ fetchImpl }))
    ).rejects.toThrow(/private\/loopback/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows private hosts when opted in", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const context = ctx({ fetchImpl });
    context.options.http.allowPrivateNetwork = true;
    const r = await run("http_request", { url: "http://127.0.0.1/health" }, context);
    expect((r as { data: { status: number } }).data.status).toBe(200);
  });

  it("rejects non-http protocols", async () => {
    await expect(
      run("http_request", { url: "file:///etc/passwd" }, ctx({ fetchImpl: vi.fn() }))
    ).rejects.toThrow(/unsupported protocol/);
  });

  it("rejects an invalid URL", async () => {
    await expect(
      run("http_request", { url: "not a url" }, ctx({ fetchImpl: vi.fn() }))
    ).rejects.toThrow(/invalid URL/);
  });
});

describe("http group — requests", () => {
  it("performs a GET and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: "world" }));
    const r = await run("http_request", { url: "https://example.com/api" }, ctx({ fetchImpl }));
    const data = (r as { data: { status: number; body: { hello: string } } }).data;
    expect(data.status).toBe(200);
    expect(data.body.hello).toBe("world");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends a POST body and custom headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("created", { status: 201 }));
    await run(
      "http_request",
      {
        url: "https://example.com/things",
        method: "POST",
        headers: { "x-test": "1" },
        body: "payload"
      },
      ctx({ fetchImpl })
    );
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("payload");
    expect((init.headers as Record<string, string>)["x-test"]).toBe("1");
  });

  it("does not send a body for GET", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await run("http_request", { url: "https://x.com", body: "ignored" }, ctx({ fetchImpl }));
    expect((fetchImpl.mock.calls[0][1] as RequestInit).body).toBeUndefined();
  });

  it("executes a GraphQL query", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { me: { id: "1" } } }));
    const r = await run(
      "http_graphql",
      { url: "https://api.example.com/graphql", query: "{ me { id } }", variables: { x: 1 } },
      ctx({ fetchImpl })
    );
    const data = (r as { data: { data: { me: { id: string } } } }).data;
    expect(data.data.me.id).toBe("1");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      query: "{ me { id } }",
      variables: { x: 1 }
    });
  });
});
