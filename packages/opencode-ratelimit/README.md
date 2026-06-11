# @vymalo/opencode-ratelimit

OpenCode plugin that makes OpenAI-compatible providers **rate-limit aware**. It reads the IETF draft-03 rate-limit response headers emitted by [Envoy Gateway](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/)'s global rate limiting (`x-ratelimit-limit` / `-remaining` / `-reset`), proactively pauses new requests when the quota is exhausted, and backs off + retries on HTTP `429` — so your OpenCode client cooperates with the gateway instead of hammering it.

Auth-agnostic by design: it runs as an OpenCode `config` hook and only wraps the provider's `fetch`. It never reads or sets `Authorization`, so it composes with `@vymalo/opencode-oauth2`, static API keys, or no auth at all.

## Why use this

OpenCode has no built-in client-side rate-limit handling. If your inference sits behind a gateway that advertises a quota on every response, a burst of requests (streaming + title generation + parallel tool calls) blows through the limit and earns a wall of `429`s. This plugin observes the advertised quota and the reset window and waits the right amount of time — automatically, per provider.

## How it works

OpenCode's plugin API has **no post-response hook**, so the only way to observe response status and headers is to inject a custom `fetch` onto the provider's `options.fetch` during the `config` hook (OpenCode forwards it to the AI SDK provider). This plugin wraps that fetch:

1. **Pre-request gate** — if the last response said `remaining: 0`, hold new requests until `x-ratelimit-reset` elapses.
2. **Send** the request through the underlying fetch (or any fetch a prior plugin already installed).
3. **Read** the rate-limit headers from the response and update per-provider state.
4. **On `429`** — wait the reset window (`x-ratelimit-reset`, or `Retry-After` as a fallback) and retry, up to `maxRetries`.

The `Response` is returned untouched (no `.clone()`), so the streaming body reaches OpenCode intact.

> **Where the headers live.** Envoy attaches its rate-limit `BackendTrafficPolicy` to a specific route — in practice `/v1/chat/completions`, **not** `/v1/models`. So the plugin sees the quota on the inference calls that matter, and a `curl` of `/v1/models` may show no `x-ratelimit-*` at all. The `limit` header is also commonly *multi-policy*, e.g. `x-ratelimit-limit: 200, 200;w=60, 200000;w=60, 50000000;w=2592000` — the parser takes the first token as `limit`, while `remaining`/`reset` already track whichever bucket is closest to its cap (which is all the throttle logic needs).

## Installation

```sh
npm install @vymalo/opencode-ratelimit
```

## Usage

A provider opts in via `options.meta.rateLimit`. All fields are optional:

```json
{
  "plugin": ["@vymalo/opencode-ratelimit"],
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "meta": {
          "rateLimit": {
            "enabled": true,
            "maxWaitMs": 0,
            "maxRetries": 5,
            "headerPrefix": "x-ratelimit"
          }
        }
      }
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to opt a provider out while keeping the block. Omitting the whole `rateLimit` block also opts out. |
| `maxWaitMs` | `0` | Upper bound on any single wait, in ms. **`0` = unlimited** (wait the full reset window). |
| `maxRetries` | `5` | How many times a `429` is retried before the response is handed back as-is. |
| `headerPrefix` | `x-ratelimit` | Lowercased prefix of the draft-03 triple. Remap for gateways that use e.g. `ratelimit-*`. |

If you also use `@vymalo/opencode-oauth2`, list it **before** this plugin in `plugin` (config hooks run in registration order). It is only a soft recommendation — this plugin's fetch wrapping is auth-independent.

## Caveats

### Long waits can be cut short by OpenCode's own timeouts

OpenCode wraps the injected `fetch` with its own `headerTimeout` / `chunkTimeout` logic, and our pre-request gate and `429` backoff wait **inside** that fetch. With the default `maxWaitMs: 0`, a 55-second reset window means a 55-second wait — which OpenCode may abort if it exceeds the header timeout. When that happens the wait is cancelled cleanly (a `ratelimit_wait_aborted` event is logged and the abort is propagated as a normal cancellation).

If you expect long waits, raise the provider's `headerTimeout` (and `chunkTimeout`) above your largest reset window:

```json
"options": { "headerTimeout": 90000, "chunkTimeout": 90000 }
```

### State is in-memory only

Unlike `@vymalo/opencode-oauth2` and `-models-info`, this plugin keeps **no cache on disk** — rate-limit windows are measured in seconds, so per-process state is all that matters and surviving a restart would be pointless (and stale).

### Concurrency

During a known cooldown window all in-flight callers share a **single** timer (a 10-way burst produces one wait, not ten) and resume together; each still honors its own request `signal`. Outside a cooldown, requests flow concurrently and each response's headers correct the shared state — a burst that races past `remaining: 0` is mopped up by the `429` backoff path.

## Logged events

Structured events flow through OpenCode's log stream (service `opencode-ratelimit-plugin`) with a JSON-console fallback:

| Event | Level | When |
| --- | --- | --- |
| `ratelimit_plugin_initialized` | info | once per config load (`providerCount`) |
| `ratelimit_provider_enabled` | info | a provider opted in |
| `ratelimit_provider_skipped` | debug | a provider did not opt in |
| `ratelimit_quota` | debug | every response (`remaining`, `limit`, `resetSeconds`) |
| `ratelimit_throttle_wait` | info | pre-request gate engaged |
| `ratelimit_429_backoff` | warn | a `429` was retried |
| `ratelimit_wait_aborted` | warn | a wait was cancelled by the request signal |
| `ratelimit_giveup` | error | `maxRetries` exhausted, `429` returned as-is |
| `ratelimit_header_parse_failed` | debug | a response's headers could not be parsed |

## Library API

The `./lib` subpath exports the testable internals for embedders: `parseRateLimit`, `parseRateLimitOptions`, `makeRateLimitFetch`, `installRateLimiter`, `createProviderState`, and the `createOpencodeRatelimitPlugin` factory.

## License

MIT
