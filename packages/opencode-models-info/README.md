# @vymalo/opencode-models-info

OpenCode plugin that **enriches** model entries already contributed by other plugins (or by your `opencode.json`) with full metadata — context length, output limit, pricing, modalities, and capability flags (`tool_call`, `reasoning`, `attachment`) — by fetching from a provider-supplied **OpenRouter-shaped** endpoint.

Auth-agnostic by design: the plugin runs as an OpenCode `config` hook *after* other plugins have populated providers and headers, so it composes with `@vymalo/opencode-oauth2`, static API keys, or any other auth scheme without depending on any of them.

## Why use this

OpenCode supports rich per-model metadata (context window, USD/M-token cost, tool-call/reasoning/attachment flags) but you usually have to handwrite it in `opencode.json`. If your provider exposes a JSON endpoint with this info (OpenRouter, LiteLLM with the OpenRouter-compat extension, your own gateway), this plugin fetches it once, merges it onto every model, caches the result, and stays out of the way.

## Installation

```sh
npm install @vymalo/opencode-models-info
```

Add it to your `opencode.json` plugin list:

```json
{
  "plugin": ["@vymalo/opencode-models-info"]
}
```

## Usage

`meta.modelsInfoUrl` is **the HTTP(S) endpoint that returns OpenRouter-shaped models JSON** (see [Expected response shape](#expected-response-shape-openrouter)). The plugin cares about the *response shape*, not the *service* — **any OpenRouter-compatible endpoint works**: OpenRouter itself, a self-hosted gateway, a LiteLLM proxy, or a dedicated metadata route on your own API. `modelsInfoUrl` can be an absolute URL or a path resolved against `options.baseURL`.

**Your own gateway** (relative path, resolved against `baseURL` → `https://gateway.example.com/v1/models`):

```json
{
  "plugin": ["@vymalo/opencode-models-info"],
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://gateway.example.com/v1",
        "meta": {
          "modelsInfoUrl": "models",
          "modelsInfoTtlSeconds": 86400,
          "modelsInfoTimeoutMs": 5000
        }
      },
      "models": { "my-model-large": {} }
    }
  }
}
```

**OpenRouter's public catalog** (absolute URL — a concrete endpoint you can try right now):

```json
{
  "plugin": ["@vymalo/opencode-models-info"],
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "meta": { "modelsInfoUrl": "https://openrouter.ai/api/v1/models" }
      },
      "models": { "anthropic/claude-3.5-sonnet": {} }
    }
  }
}
```

> **What counts as "compatible"?** Returning the shape below — that's the whole contract. The bar is low: a **bare top-level array** (no `data` wrapper) is accepted, and the mapping is **partial**, so you only need to emit the fields you want enriched (e.g. just `id` + `context_length` + `pricing`). **But note:** a vanilla OpenAI-compatible `/v1/models` returns only `id` / `object` / `owned_by` — *none* of the fields this plugin maps — so pointing `modelsInfoUrl` there fetches successfully and enriches nothing. The endpoint has to actually carry the richer data.

That's it. After OpenCode starts:

1. The hook picks up every provider with a `meta.modelsInfoUrl`.
2. It `GET`s that URL once, sending whatever `options.headers` the provider already has (so it composes with any auth plugin — see [Auth composition](#auth-composition)).
3. Each model entry whose `id` matches an entry in the response gets `limit`, `cost`, `modalities`, `tool_call`, `reasoning`, `attachment`, etc. filled in — **only where they were not already set** (upstream wins).
4. The response is cached on disk for `modelsInfoTtlSeconds` (default 24h), keyed by `(providerId, url, modelsInfoHeaders)`. ETags are honored.
5. On fetch error with a valid cache, the stale snapshot is served — the plugin never blocks OpenCode startup on a network failure.

### URL resolution

`meta.modelsInfoUrl` resolves against `options.baseURL` using standard WHATWG URL semantics:

| `baseURL`                  | `modelsInfoUrl`        | Resolved URL                          |
| -------------------------- | ---------------------- | ------------------------------------- |
| `https://x.test/v1`        | `models/info`          | `https://x.test/v1/models/info`       |
| `https://x.test/v1`        | `/models/info`         | `https://x.test/models/info`          |
| `https://x.test/v1`        | `https://o.test/m`     | `https://o.test/m`                    |

Two practical rules: drop the leading `/` to keep the metadata path under your inference API path; keep the leading `/` to escape to a different path under the same host.

### Options

| Option                          | Default            | Notes                                                                 |
| ------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `meta.modelsInfoUrl`            | _(required)_       | Absolute URL or path resolved against `options.baseURL` (see above). |
| `meta.modelsInfoTtlSeconds`     | `86400` (24h)      | Cache TTL.                                                            |
| `meta.modelsInfoTimeoutMs`      | `5000`             | Per-fetch HTTP timeout.                                               |
| `meta.modelsInfoHeaders`        | _(none)_           | Extra request headers. Override `options.headers` on conflict. Included in the cache key, so a tenant switch busts the cache. |

### Auth composition

The plugin sends the union of `options.headers` and `meta.modelsInfoHeaders` (meta wins on conflict). This makes three common setups work without configuration:

1. **Public metadata endpoint** (e.g. OpenRouter's `/models`) — no auth needed.
2. **Static API key** — drop a `Bearer` into `options.headers` once, both inference and metadata use it.
3. **OAuth2 via [`@vymalo/opencode-oauth2`](../opencode-oauth2/README.md) ≥ 0.4.0** — that plugin stamps the cached bearer into `options.headers.Authorization` at config time so the metadata fetch inherits it automatically. The chat-time path still uses freshly-refreshed tokens.

If you need a different token for the metadata endpoint than for inference (e.g. a service-account bearer), set it explicitly under `meta.modelsInfoHeaders.Authorization` — it'll override whatever the provider has set.

### Expected response shape (OpenRouter)

```json
{
  "data": [
    {
      "id": "model-a",
      "name": "Model A",
      "context_length": 128000,
      "pricing": { "prompt": "0.000003", "completion": "0.000015" },
      "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["text"] },
      "top_provider": { "max_completion_tokens": 4096 },
      "supported_parameters": ["tools", "temperature", "reasoning"]
    }
  ]
}
```

A bare top-level array (no `data` wrapper) is also accepted.

### Field mapping

| OpenRouter                                              | OpenCode                  |
| ------------------------------------------------------- | ------------------------- |
| `context_length` + `top_provider.max_completion_tokens` | `limit.context` / `limit.output` |
| `pricing.prompt` / `.completion` (USD/token)            | `cost.input` / `cost.output` (USD per 1M tokens — converted) |
| `pricing.input_cache_read` / `.input_cache_write`       | `cost.cache_read` / `cost.cache_write` |
| `architecture.input_modalities` / `.output_modalities`  | `modalities.input` / `modalities.output` (filtered to OpenCode's enum) |
| `supported_parameters: ["tools" or "tool_choice"]`      | `tool_call: true`         |
| `supported_parameters: ["reasoning" / "thinking" / …]`  | `reasoning: true`         |
| `supported_parameters: ["temperature"]`                 | `temperature: true`       |
| Non-text input modality present                         | `attachment: true`        |
| `name`                                                  | `name` (if absent)        |

## Cache location

| OS      | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| macOS   | `~/Library/Caches/opencode-models-info/`                             |
| Linux   | `${XDG_CACHE_HOME:-~/.cache}/opencode-models-info/`                  |
| Windows | `%LOCALAPPDATA%\opencode-models-info\`                               |

Files are named by `sha256(providerId::url)`, `0o600`, atomic-rename-on-write.

## Testing

Unit tests run against mocked `fetch`:

```sh
pnpm --filter @vymalo/opencode-models-info test
```

Integration tests run against a real HTTP server (WireMock) from the workspace's shared [`test-env/`](../../test-env/) compose stack. They skip themselves when `INTEGRATION_MODELS_INFO_URL` is unset:

```sh
pnpm test:env:up                                                # from repo root
pnpm --filter @vymalo/opencode-models-info test:integration
pnpm test:env:down

# Or one-shot from repo root: spin up, run all integration suites, tear down.
pnpm test:integration
```

The integration suite exercises real network round-trips, ETag handling (`304 Not Modified`), `modelsInfoHeaders` propagation, and the disk cache — all against a fixed catalog fixture under [`test-env/wiremock/__files/openrouter-catalog.json`](../../test-env/wiremock/__files/openrouter-catalog.json).

## Library API

For embedding the enrichment logic outside an OpenCode hook (e.g. tests or custom tooling), import from the `/lib` subpath:

```ts
import { enrichConfig, FileCacheStore, createJsonConsoleLogger } from "@vymalo/opencode-models-info/lib";
```

## License

MIT
