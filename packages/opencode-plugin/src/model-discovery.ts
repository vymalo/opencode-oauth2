import type { Logger } from "./logging.js";
import type { RawModel, TokenSet } from "./types.js";

export interface ModelDiscoveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: Logger;
}

export function buildModelsUrl(baseURL: string): string {
  const url = new URL(baseURL);
  const path = url.pathname.replace(/\/+$/, "");

  if (path.endsWith("/v1")) {
    url.pathname = `${path}/models`;
  } else {
    url.pathname = `${path}/v1/models`;
  }

  return url.toString();
}

function parseModelsResponse(payload: unknown): RawModel[] {
  const candidates: unknown[] =
    Array.isArray(payload) ? payload :
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];

  const models: RawModel[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }

    models.push(item as RawModel);
  }

  return models;
}

export async function fetchModels(
  baseURL: string,
  token: TokenSet,
  options: ModelDiscoveryOptions = {}
): Promise<RawModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const modelsUrl = buildModelsUrl(baseURL);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(modelsUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`model discovery failed (${response.status})`);
    }

    const payload = (await response.json()) as unknown;
    const models = parseModelsResponse(payload);

    if (models.length === 0) {
      options.logger?.warn("model_discovery_empty", { modelsUrl });
    }

    return models;
  } finally {
    clearTimeout(timeout);
  }
}
