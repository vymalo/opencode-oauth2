# Model metadata enrichment

How `@vymalo/opencode-models-info` runs inside OpenCode: the single hook it registers, how it composes with any auth scheme, where it caches, and what happens when the metadata endpoint misbehaves.

For the copy-paste config reference (every option, the full OpenRouter→OpenCode field-mapping table), see the package README: [`packages/opencode-models-info/README.md`](../packages/opencode-models-info/README.md). This page is for the adopter who needs to reason about composition and failure modes. The original design rationale lives in [`plans/models-info-plan.md`](../plans/models-info-plan.md).

## What it does

OpenCode supports rich per-model metadata — context window, output limit, USD-per-1M-token cost, and `tool_call` / `reasoning` / `attachment` capability flags — but you normally hand-write it in `opencode.json`. If your provider exposes an OpenRouter-shaped `/models` endpoint, this plugin fetches it once, merges the metadata onto your model entries, caches the result, and stays out of the way.

It is **auth-agnostic** and does **not** depend on `@vymalo/opencode-oauth2`. It only mutates the already-assembled OpenCode config, so it works with static API keys, oauth2, or no auth at all.

## The one hook

The plugin registers a single OpenCode hook: `config` (plugin load). Source: [`packages/opencode-models-info/src/opencode.ts`](../packages/opencode-models-info/src/opencode.ts).

Because the host runs every plugin's `config` hook in registration order, by the time this one fires, other plugins (oauth2, or your static config) have already populated `config.provider[*]` — including `options.headers`. The hook then, for every provider:

1. **Opts in or skips.** Reads `options.meta.modelsInfoUrl`. No URL → the provider is left untouched. Safe to enable globally.
2. **Resolves the URL** against `options.baseURL` (see [URL resolution](#url-resolution)).
3. **Loads the catalog** — from the on-disk cache if fresh, otherwise fetches (see [Caching](#caching-and-failure-modes)).
4. **Merges** derived metadata onto each model whose `id` (or declared `id`) matches an entry in the catalog. The merge is **upstream-wins**: any field already set on the model entry is never overwritten. Running the hook twice is a no-op.

Providers run in parallel (`Promise.allSettled`); one bad endpoint never blocks another's enrichment, and any unexpected throw is surfaced as a `models_info_enrichment_failed` log event rather than silently swallowed.

## Auth composition

The fetch sends the union of the provider's `options.headers` and the meta-specific `meta.modelsInfoHeaders` (meta wins on conflict). That single rule covers the three common setups:

| Setup | What you do |
| --- | --- |
| **Public metadata endpoint** (e.g. OpenRouter's `/models`) | Nothing — no auth needed. |
| **Static API key** | Put the `Bearer` in `options.headers` once; both inference and the metadata fetch use it. |
| **OAuth2 via `@vymalo/opencode-oauth2` ≥ 0.4.0** | Nothing — that plugin stamps the cached bearer onto `options.headers.Authorization` at config time (see [architecture.md](./architecture.md#config--plugin-load)), so this plugin inherits it automatically. |

If the metadata endpoint needs a *different* credential than inference (e.g. a service-account token), set `meta.modelsInfoHeaders.Authorization` — it overrides whatever the provider carries.

> **Why this works with oauth2 without coupling.** The two plugins never import each other. oauth2 writes its token into the shared, already-resolved provider config; this plugin reads whatever is there. The oauth2 `chat.headers` hook still injects a freshly-refreshed token per chat request, so a slightly-stale config-time header can only ever affect *this* plugin's metadata fetch — never the actual inference call.

## URL resolution

`meta.modelsInfoUrl` resolves against `options.baseURL` with standard WHATWG URL semantics:

| `baseURL` | `modelsInfoUrl` | Resolves to | Use when |
| --- | --- | --- | --- |
| `https://x.test/v1` | `models/info` | `https://x.test/v1/models/info` | metadata sits under the inference path |
| `https://x.test/v1` | `/models/info` | `https://x.test/models/info` | metadata sits at a different path on the same host |
| `https://x.test/v1` | `https://o.test/m` | `https://o.test/m` | metadata lives on a different host entirely |

Rule of thumb: **drop the leading `/`** to keep the metadata path under your API path; **keep the leading `/`** to escape to the host root.

## Caching and failure modes

The catalog is cached on disk so repeated boots don't re-hit the network.

- **Location** — per-OS cache dir under the `opencode-models-info` namespace: `~/Library/Caches/opencode-models-info/` (macOS), `${XDG_CACHE_HOME:-~/.cache}/opencode-models-info/` (Linux), `%LOCALAPPDATA%\opencode-models-info\` (Windows). Files are `0o600`, written via atomic rename.
- **Key** — `sha256(providerId :: resolvedUrl :: modelsInfoHeaders)`. The user-set `meta.modelsInfoHeaders` are part of the key (switching an `x-tenant` selector busts the cache), but the provider's other headers are **not** — a rotating OAuth2 bearer must not thrash the cache.
- **TTL** — `meta.modelsInfoTtlSeconds`, default 24h. The current config TTL is applied on every write, including `304` revalidations, so tightening it in `opencode.json` takes effect on the next revalidation.
- **Revalidation** — the stored `ETag` is sent as `If-None-Match`; a `304` reuses the cached models and just bumps `fetchedAt`.

Failure handling is deliberately non-fatal — the plugin must never block OpenCode startup:

| Situation | Behavior |
| --- | --- |
| Fetch fails (network, timeout, non-2xx) **with** a cached snapshot | Serve the **stale** snapshot; log `models_info_fetch_failed_using_stale`. |
| Fetch fails **without** any cache | Skip enrichment for that provider; log `models_info_fetch_failed_no_cache`. |
| Response is malformed (non-empty body that filters down to zero valid entries) | Treated as a parse error → falls back to stale cache, **never** overwrites good data with `[]`. |
| Disk cache write fails (read-only `$HOME`, etc.) | Best-effort: log `models_info_cache_write_failed` and still enrich from the freshly-fetched in-memory record. |

Per-fetch timeout defaults to 5s (`meta.modelsInfoTimeoutMs`).

## Log events

All structured, `snake_case`, emitted through both the JSON console and OpenCode's `client.app.log`:

| Event | Level | Meaning |
| --- | --- | --- |
| `models_info_enriched` | info | A provider's models were enriched (`enrichedCount` / `totalModels` / `sourceModels`). |
| `models_info_fetched` | info | A live fetch succeeded and the cache was written. |
| `models_info_cache_hit` | debug | Served from a fresh cache entry; no network. |
| `models_info_not_modified` | debug | `304` revalidation; cached models reused. |
| `models_info_fetch_failed_using_stale` | warn | Fetch failed; stale cache served. |
| `models_info_fetch_failed_no_cache` | warn | Fetch failed and nothing cached; provider left un-enriched. |
| `models_info_cache_write_failed` | warn | Disk write failed; enrichment proceeded from memory. |
| `models_info_enrichment_failed` | error | Unexpected throw while enriching a provider. |

## Field mapping (summary)

The exact conversions live in [`packages/opencode-models-info/src/mapping.ts`](../packages/opencode-models-info/src/mapping.ts) and the full table is in the package README. Highlights worth knowing:

- OpenRouter `pricing.prompt` / `.completion` are **USD per token** strings; OpenCode `cost.input` / `.output` are **USD per 1M tokens** numbers — converted (`× 1_000_000`, rounded to 6 dp).
- `limit` is only emitted when **both** `context` and `output` are known (OpenCode rejects a partial `limit`).
- Modalities are filtered to OpenCode's enum (`text | audio | image | video | pdf`); a non-text input modality also sets `attachment: true`.
- `tool_call` / `reasoning` / `temperature` are derived from `supported_parameters`.
