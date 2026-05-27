import type { MetaProviderOptions } from "./types.js";

export const DEFAULT_TTL_SECONDS = 86_400;
export const DEFAULT_TIMEOUT_MS = 5_000;

const META_KEY = "meta";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw.length > 0) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/**
 * Parse a provider's `options.meta` for opt-in model-info fields. Returns
 * `null` if the provider has not opted in (no `meta.modelsInfoUrl`).
 *
 * Resolves `modelsInfoUrl` against `baseURL` when it is a relative path so
 * config authors can write `"meta": { "modelsInfoUrl": "/v1/models/info" }`.
 */
export function parseMetaOptions(
  providerOptions: Record<string, unknown> | undefined
): MetaProviderOptions | null {
  if (!providerOptions) {
    return null;
  }

  const meta = asRecord(providerOptions[META_KEY]);
  if (!meta) {
    return null;
  }

  const rawUrl = asString(meta.modelsInfoUrl);
  if (!rawUrl) {
    return null;
  }

  const baseURL = asString(providerOptions.baseURL);
  const modelsInfoUrl = resolveUrl(rawUrl, baseURL);

  return {
    modelsInfoUrl,
    modelsInfoTtlSeconds: asPositiveInt(meta.modelsInfoTtlSeconds, DEFAULT_TTL_SECONDS),
    modelsInfoTimeoutMs: asPositiveInt(meta.modelsInfoTimeoutMs, DEFAULT_TIMEOUT_MS),
    modelsInfoHeaders: asStringMap(meta.modelsInfoHeaders),
    modelsInfoFormat: "openrouter"
  };
}

function resolveUrl(candidate: string, baseURL: string | undefined): string {
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  if (!baseURL) {
    return candidate;
  }
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  const rel = candidate.startsWith("/") ? candidate.slice(1) : candidate;
  try {
    return new URL(rel, base).toString();
  } catch {
    return candidate;
  }
}
