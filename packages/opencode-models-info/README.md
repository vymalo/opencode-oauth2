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

For every provider you want enriched, add `options.meta.modelsInfoUrl`:

```json
{
  "plugin": ["@vymalo/opencode-models-info"],
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://gateway.example.com/v1",
        "meta": {
          "modelsInfoUrl": "/models/info",
          "modelsInfoTtlSeconds": 86400,
          "modelsInfoTimeoutMs": 5000
        }
      },
      "models": {
        "gpt-x-large": {}
      }
    }
  }
}
```

That's it. After OpenCode starts:

1. The hook picks up every provider with a `meta.modelsInfoUrl`.
2. It `GET`s that URL once (relative paths resolve against `baseURL`), reusing whatever auth headers the provider's other plugins/config already set.
3. Each model entry whose `id` matches an entry in the response gets `limit`, `cost`, `modalities`, `tool_call`, `reasoning`, `attachment`, etc. filled in — **only where they were not already set** (upstream wins).
4. The response is cached on disk for `modelsInfoTtlSeconds` (default 24h), keyed by `(providerId, url)`. ETags are honored.
5. On fetch error with a valid cache, the stale snapshot is served — the plugin never blocks OpenCode startup on a network failure.

### Options

| Option                          | Default            | Notes                                                                 |
| ------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `meta.modelsInfoUrl`            | _(required)_       | Absolute URL or path relative to `options.baseURL`.                   |
| `meta.modelsInfoTtlSeconds`     | `86400` (24h)      | Cache TTL.                                                            |
| `meta.modelsInfoTimeoutMs`      | `5000`             | Per-fetch HTTP timeout.                                               |
| `meta.modelsInfoHeaders`        | _(none)_           | Extra headers merged onto the request (rare — most users won't need). |

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
