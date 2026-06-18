import { json, reqString, type ToolContext, type ToolSpec } from "../tool-spec.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

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
 * Reject obvious loopback / private / link-local destinations. This is a
 * literal-host guard: it does not resolve DNS, so a public name that resolves
 * to a private IP (DNS rebinding) is not caught. Documented in docs/devtools.md.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) {
    return true;
  }
  if (h === "::1" || h === "::" || h === "0.0.0.0") {
    return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) {
    return true; // unique-local + link-local IPv6
  }
  if (isPrivateIpv4(h)) {
    return true;
  }
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
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

async function readBody(res: Response): Promise<{ body: unknown; bodyText: string }> {
  const bodyText = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && bodyText.length > 0) {
    try {
      return { body: JSON.parse(bodyText), bodyText };
    } catch {
      /* fall through to text */
    }
  }
  return { body: bodyText, bodyText };
}

export const HTTP_TOOLS: readonly ToolSpec[] = [
  {
    name: "http_request",
    group: "http",
    description:
      "Make an HTTP request (GET/POST/PUT/PATCH/DELETE/…) and return the status, response headers, and parsed body. JSON responses are parsed automatically.",
    input: {
      url: { type: "string", description: "Absolute http(s) URL." },
      method: {
        type: "string",
        optional: true,
        enum: METHODS,
        description: "HTTP method (default GET)."
      },
      headers: { type: "object", optional: true, properties: {}, description: "Request headers." },
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
      const body = typeof args.body === "string" ? args.body : undefined;
      const res = await ctx.fetchImpl(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        signal: AbortSignal.timeout(ctx.options.http.timeoutMs)
      });
      const responseHeaders = Object.fromEntries(res.headers.entries());
      const { body: parsed, bodyText } = await readBody(res);
      return json(
        {
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
          headers: responseHeaders,
          body: parsed
        },
        `${method} ${url.href} → ${res.status} ${res.statusText}\n\n${bodyText.slice(0, 4000)}`
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
        type: "object",
        optional: true,
        properties: {},
        description: "Query variables."
      },
      headers: {
        type: "object",
        optional: true,
        properties: {},
        description: "Extra request headers."
      }
    },
    handler: async (args, ctx) => {
      const url = assertAllowed(reqString(args, "url"), ctx);
      const query = reqString(args, "query");
      const variables =
        typeof args.variables === "object" && args.variables !== null ? args.variables : {};
      const res = await ctx.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...asHeaders(args.headers)
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(ctx.options.http.timeoutMs)
      });
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
