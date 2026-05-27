import type { FetchModelsResult, OpenRouterModel, OpenRouterModelsResponse } from "./types.js";

export interface FetchOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  etag?: string;
  fetchImpl?: typeof fetch;
}

/**
 * GET the models-info endpoint and return either the parsed entries, a
 * not-modified marker (when the server respects the supplied `If-None-Match`),
 * or an error result. Never throws — the plugin must remain non-fatal.
 */
export async function fetchOpenRouterModels(opts: FetchOptions): Promise<FetchModelsResult> {
  const impl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(opts.headers ?? {})
    };
    if (opts.etag) {
      headers["if-none-match"] = opts.etag;
    }

    const response = await impl(opts.url, {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (response.status === 304) {
      return { status: "not-modified", etag: opts.etag };
    }

    if (!response.ok) {
      return { status: "error", error: `HTTP ${response.status}` };
    }

    const body = (await response.json()) as unknown;
    const models = normalizeResponse(body);
    if (!models) {
      return { status: "error", error: "unexpected response shape" };
    }

    return {
      status: "ok",
      etag: response.headers.get("etag") ?? undefined,
      models
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResponse(body: unknown): OpenRouterModel[] | undefined {
  if (Array.isArray(body)) {
    return validateFiltered(body);
  }
  if (body && typeof body === "object") {
    const data = (body as OpenRouterModelsResponse).data;
    if (Array.isArray(data)) {
      return validateFiltered(data);
    }
  }
  return undefined;
}

/**
 * Filter to entries with a string `id`, but reject the whole response if a
 * non-empty input came in and every entry was filtered out — that's a parse
 * error, not a legitimate empty catalog, and we don't want to overwrite a
 * previously-good cache with []. An input that was empty to begin with is
 * still a valid (if unusual) response.
 */
function validateFiltered(input: unknown[]): OpenRouterModel[] | undefined {
  const filtered = input.filter(isOpenRouterModel);
  if (input.length > 0 && filtered.length === 0) {
    return undefined;
  }
  return filtered;
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}
