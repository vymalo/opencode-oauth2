import { json, reqString, type ToolContext, type ToolSpec } from "../tool-spec.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10_000_000; // 10 MB — cap buffered response bodies.

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    return false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true; // link-local incl. cloud metadata 169.254.169.254
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true; // CGNAT
  }
  return false;
}

/**
 * Extract a dotted IPv4 from an IPv4-mapped IPv6 literal — both the dotted
 * (`::ffff:127.0.0.1`) and the hex (`::ffff:7f00:1`, what `new URL()` normalizes
 * to) forms. Returns null if not a mapped address.
 */
function mappedIpv4(h: string): string | null {
  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    return dotted[1];
  }
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Reject loopback / private / link-local destinations. IPv6-prefix and IPv4
 * range checks only run on actual IP *literals* — a DNS name like `fdroid.org`
 * (which starts with `fd`) is NOT an IPv6 ULA and must not be blocked. This is
 * still a literal-host guard: it does not resolve DNS, so a public name that
 * resolves to a private IP (DNS rebinding) is not caught — see docs/devtools.md.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpv6 = h.includes(":");
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  if (!isIpv6 && !isIpv4) {
    // Plain DNS name — only the localhost family is private.
    return h === "localhost" || h.endsWith(".localhost");
  }
  if (isIpv4) {
    return isPrivateIpv4(h);
  }
  // IPv6 literal.
  if (h === "::1" || h === "::") {
    return true;
  }
  const mapped = mappedIpv4(h);
  if (mapped) {
    return isPrivateIpv4(mapped);
  }
  if (h.startsWith("fc") || h.startsWith("fd")) {
    return true; // unique-local fc00::/7
  }
  if (/^fe[89ab]/.test(h)) {
    return true; // link-local fe80::/10
  }
  return h.startsWith("ff"); // multicast ff00::/8
}

function assertAllowed(rawUrl: string, ctx: ToolContext): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol "${url.protocol}" (only http/https)`);
  }
  if (!ctx.options.http.allowPrivateNetwork && isBlockedHost(url.hostname)) {
    throw new Error(
      `refusing to reach private/loopback host "${url.hostname}" (set http.allowPrivateNetwork to allow)`
    );
  }
  return url;
}

function asHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object") {
    throw new Error('"headers" must be an object of string values');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Fetch with **manual** redirect handling so every hop is re-validated by the
 * SSRF guard — the default follow-redirects behaviour would let a public URL
 * 30x to `http://127.0.0.1/…` and bypass `allowPrivateNetwork: false`.
 */
async function fetchGuarded(
  start: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
  ctx: ToolContext
): Promise<Response> {
  let url = start;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; ; hop++) {
    const res = await ctx.fetchImpl(url, {
      method,
      headers: init.headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.options.http.timeoutMs)
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      return res;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
    }
    const next = new URL(location, url);
    assertAllowed(next.href, ctx); // re-check the redirect target
    // 303 (and 301/302 from a non-idempotent method) → GET with no body.
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
    }
    url = next;
    await res.body?.cancel().catch(() => {});
  }
}

/** Read a response body, capped at MAX_RESPONSE_BYTES, parsing JSON when applicable. */
async function readBody(
  res: Response
): Promise<{ body: unknown; bodyText: string; truncated: boolean }> {
  let text = "";
  let truncated = false;
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        const keep = value.byteLength - (received - MAX_RESPONSE_BYTES);
        chunks.push(value.subarray(0, Math.max(0, keep)));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } else {
    text = await res.text();
  }
  const contentType = res.headers.get("content-type") ?? "";
  let body: unknown = text;
  if (contentType.includes("application/json") && text.length > 0 && !truncated) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep as text */
    }
  }
  return { body, bodyText: text, truncated };
}

export const HTTP_TOOLS: readonly ToolSpec[] = [
  {
    name: "http_request",
    group: "http",
    description:
      "Make an HTTP request (GET/POST/PUT/PATCH/DELETE/…) and return the status, response headers, and parsed body. JSON responses are parsed automatically. Redirects are followed but re-checked against the SSRF guard; response bodies are capped at 10 MB.",
    input: {
      url: { type: "string", description: "Absolute http(s) URL." },
      method: {
        type: "string",
        optional: true,
        enum: METHODS,
        description: "HTTP method (default GET)."
      },
      headers: {
        type: "record",
        optional: true,
        valueType: "string",
        description: "Request headers (e.g. Authorization, Content-Type)."
      },
      body: {
        type: "string",
        optional: true,
        description: "Request body (string; set Content-Type yourself)."
      }
    },
    handler: async (args, ctx) => {
      const url = assertAllowed(reqString(args, "url"), ctx);
      const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      const headers = asHeaders(args.headers);
      const rawBody = typeof args.body === "string" ? args.body : undefined;
      const body = method === "GET" || method === "HEAD" ? undefined : rawBody;
      const res = await fetchGuarded(url, { method, headers, body }, ctx);
      const responseHeaders = Object.fromEntries(res.headers.entries());
      const { body: parsed, bodyText, truncated } = await readBody(res);
      return json(
        {
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
          headers: responseHeaders,
          body: parsed,
          truncated
        },
        `${method} ${url.href} → ${res.status} ${res.statusText}${truncated ? " (body truncated at 10 MB)" : ""}\n\n${bodyText.slice(0, 4000)}`
      );
    }
  },
  {
    name: "http_graphql",
    group: "http",
    description:
      "Execute a GraphQL query or mutation against an endpoint and return the structured data and errors.",
    input: {
      url: { type: "string", description: "GraphQL endpoint URL." },
      query: { type: "string", description: "The GraphQL query or mutation document." },
      variables: {
        type: "record",
        optional: true,
        valueType: "any",
        description: "Query variables."
      },
      headers: {
        type: "record",
        optional: true,
        valueType: "string",
        description: "Extra request headers (e.g. Authorization)."
      }
    },
    handler: async (args, ctx) => {
      const url = assertAllowed(reqString(args, "url"), ctx);
      const query = reqString(args, "query");
      const variables =
        typeof args.variables === "object" && args.variables !== null ? args.variables : {};
      const res = await fetchGuarded(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...asHeaders(args.headers)
          },
          body: JSON.stringify({ query, variables })
        },
        ctx
      );
      const { body, bodyText } = await readBody(res);
      const payload = (typeof body === "object" && body !== null ? body : {}) as {
        data?: unknown;
        errors?: unknown;
      };
      return json(
        { status: res.status, data: payload.data, errors: payload.errors },
        `${url.href} → ${res.status}\n\n${bodyText.slice(0, 4000)}`
      );
    }
  }
];
