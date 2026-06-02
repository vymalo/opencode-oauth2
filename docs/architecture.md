# Architecture

How `@vymalo/opencode-oauth2` actually runs inside OpenCode: what each hook does, how tokens move through the system, where they live on disk, and what to expect when something fails.

If you just want to copy YAML, jump to the [GitHub Actions](./github-actions.md) or [Kubernetes](./kubernetes.md) cookbooks. This page is for the adopter who needs to reason about failure modes.

> The workspace also ships a second, independent plugin —
> [`@vymalo/opencode-models-info`](./models-info.md) — that enriches model
> metadata after auth is resolved. It is documented separately; this page
> covers the oauth2 plugin only, plus the one place the two intersect (the
> [config-time bearer propagation](#config--plugin-load) in step 6 below).

## The two hooks

The plugin registers exactly two OpenCode hooks: `config` (plugin load) and `chat.headers` (per request).

### `config` — plugin load

Runs once when OpenCode boots the plugin. Source: [`packages/opencode-oauth2/src/opencode.ts`](../packages/opencode-oauth2/src/opencode.ts).

1. **Parse both config shapes.** Walks `config.provider[*].options.oauth2` (per-provider, recommended) and `config.pluginConfig.oauth2ModelSync.servers` (top-level array). Duplicates are de-duplicated by `id`; the provider-embedded shape wins on conflict.
2. **Register managed providers** into OpenCode's `config.provider` map. Each managed provider gets `npm: "@ai-sdk/openai-compatible"` and a normalized `options.baseURL`.
3. **Build the runtime** (`OAuth2ModelSyncPlugin`), `initialize()` (load cache), then `start({ warmup: true })`.
4. **Warmup** iterates servers, attempts `syncServer(id, { interactive: <TTY-detected> })`, and starts a per-server scheduler (`syncIntervalMinutes`, default 60).
5. **Merge discovered models** into each provider's `models` map. If a server has no cached models yet (cold start, non-interactive warmup, refresh-token expired), it stays empty in OpenCode — the user sees no models for that provider until a chat request triggers on-demand auth.
6. **Propagate the bearer.** For each managed provider, stamp `options.headers.Authorization = "<tokenType> <accessToken>"` — unless the user already set an `Authorization` header (case-insensitive), which always wins. The token comes from a **refresh-only ensure** (`ensureAccessToken(id, { interactive: false })`): a valid warmed-up token is returned as-is, a near-expiry one is transparently refreshed, and anything that would need a fresh browser / device-code prompt is skipped (`oauth2_bearer_propagation_skipped_no_token`) rather than blocking startup on a second login. This makes the token visible to *subsequent* `config` hooks, most notably [`@vymalo/opencode-models-info`](./models-info.md) fetching an OAuth2-protected `meta.modelsInfoUrl`. It's the only coupling point between the two plugins, and it's one-directional and via the shared config object — neither plugin imports the other. A stale value here is harmless: `chat.headers` (below) overwrites per-request with a freshly-ensured token, so the inference call is never affected. Emits `oauth2_bearer_propagated_to_provider_headers` (or `oauth2_bearer_propagation_skipped_user_set` / `..._skipped_no_token`).

   > **Why refresh-only, not a raw cache read.** An earlier version stamped only if the *cached* token cleared a fixed 30s expiry skew. On a first interactive device-code login against a short-lived realm, the just-minted token could already be inside that window, so the header was never stamped and models-info fetched the metadata endpoint with no `Authorization` → HTTP 401 (`models_info_fetch_failed_no_cache`). Going through `ensureAccessToken` refreshes instead of giving up, so the downstream fetch reliably carries a usable token.

The runtime is **rebuilt** if the config signature changes between hook invocations (OpenCode re-runs `config` on certain config edits). Old schedulers are stopped first.

### `chat.headers` — per request

Runs on every chat completion. Source: same file, `"chat.headers"` handler.

1. Resolve the provider id from `input.model.providerID` (preferred) or `input.provider.info.id` (fallback).
2. If the provider isn't one this plugin manages, **return without setting headers** — leaves OpenCode's other providers untouched.
3. `runtime.ensureAccessToken(providerId)` returns a fresh token (cached, refreshed, or freshly acquired).
4. Set `output.headers.Authorization = "<tokenType> <accessToken>"` (default `tokenType` is `Bearer`).
5. **Opportunistic sync trigger.** If the provider has zero cached models *after* the auth call, kick off a background `syncServer(providerId)` so the next request lists models. Failures are swallowed (next request retries).

This is the slow path: a chat request can block on the OAuth token endpoint round-trip. The fast path is the cache — once a valid access token is on disk, `ensureAccessToken` returns synchronously after a single cache read.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant OC as opencode
    participant Plugin as opencode-oauth2
    participant Cache as ~/Library/Caches/opencode-oauth2
    participant IdP as OAuth server
    participant Upstream as Provider API

    User->>OC: opencode (boot)
    OC->>Plugin: config hook
    Plugin->>Cache: load cached state for each server
    Plugin->>OC: register provider(s) (no sync if uncached and non-TTY)
    Note over Plugin: scheduler started per server

    User->>OC: opencode run --model miaou/glm-5 "..."
    OC->>Plugin: chat.headers(model=miaou/glm-5)
    Plugin->>Cache: read token for "miaou"
    alt token valid
        Plugin-->>OC: Authorization: Bearer …
    else expired with refresh_token
        Plugin->>IdP: POST /token grant_type=refresh_token
        IdP-->>Plugin: new access_token
        Plugin->>Cache: save new token
        Plugin-->>OC: Authorization: Bearer …
    else no token / refresh failed
        Plugin->>IdP: flow-specific acquire (PKCE / device / JWT bearer / …)
        IdP-->>Plugin: access_token (+ maybe refresh_token)
        Plugin->>Cache: save token
        Plugin-->>OC: Authorization: Bearer …
    end
    OC->>Upstream: POST /v1/chat/completions
    Upstream-->>OC: stream completion
```

## Token lifecycle per flow

`ensureToken` (in [`src/oauth/client.ts`](../packages/opencode-oauth2/src/oauth/client.ts)) is the single dispatch point. The state machine for any cached token is:

```
isTokenValid(cached) → yes → use cached
                    ↓ no
  machine flow? → yes → re-acquire (no refresh attempt)
                ↓ no (user flow)
  cached.refreshToken? → yes → POST grant_type=refresh_token
                              ↓ ok    → use refreshed
                              ↓ fail  → fall through
                       ↓ no
  options.interactive === false → throw (warmup gives up; cached state preserved)
  authFlow=device_code → loginDeviceCode()
  default              → loginInteractive()  (browser + PKCE)
```

What each flow re-acquires:

| Flow | Re-acquire path | Interactive? | Refresh token expected? |
| --- | --- | --- | --- |
| `authorization_code` | PKCE: browser → loopback callback → code exchange | yes | **yes** (rejected without one — see [Token Policy](#tokenpolicy)) |
| `device_code` | RFC 8628: request device code → poll token endpoint | yes (user enters code in a browser; the process polls) | **yes** |
| `client_credentials` | POST `grant_type=client_credentials` with `client_secret` | no | no (not requested, not stored) |
| `jwt_bearer` | Resolve subject JWT → POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` | no | no |
| `token_exchange` | Resolve subject JWT → POST `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (+ optional `audience`) | no | no |

The machine flows (`client_credentials`, `jwt_bearer`, `token_exchange`) dispatch **before** the refresh branch — re-presenting the platform identity is the canonical way to renew, so a stale refresh token from a different IdP run is never tried.

#### PKCE on the user flows

Both interactive flows send PKCE (RFC 7636) by default: a per-login `code_verifier` is generated, its `S256` `code_challenge` goes on the authorization request (`authorization_code`) or the device-authorization request (`device_code`), and the `code_verifier` is replayed on the token exchange / poll. This is mandatory for some IdPs — a Keycloak client with *Proof Key for Code Exchange Code Challenge Method* set rejects the request with `invalid_request: Missing parameter: code_challenge_method` if the challenge is absent, **including on the device endpoint**. Compliant servers that don't require PKCE simply ignore the extra parameters, so it's on unconditionally unless you set `pkce: false` per server (escape hatch for non-compliant IdPs that 400 on unknown parameters). The machine flows never use PKCE.

### `isTokenValid` policy

From `OAuthClient.isTokenValid`:

```ts
if (!token.expiresAt) {
  // machine flows: treat undefined expiry as INVALID (re-acquire cheap)
  // user flows:   treat undefined expiry as VALID (cost of re-auth is high)
  return !machineFlows.includes(this.server.authFlow);
}
return Date.now() + tokenExpirySkewMs < token.expiresAt;
```

`tokenExpirySkewMs` defaults to `30_000`. A token expiring in less than 30 seconds is treated as already expired, leaving headroom for the upstream round-trip.

Why the split: `expires_in` is optional in the OAuth spec. If your IdP omits it for `client_credentials`, the plugin doesn't know when the server's idea of the token expires — re-issuing one is a single POST, so we do that. For interactive flows (`authorization_code`, `device_code`), the cost is a browser dance, so we keep the older behavior: assume the cached token is still good until something explicitly fails (a 401 from upstream would surface as a chat error, prompting the user to reset auth manually).

## TTY-aware warmup

`OAuth2ModelSyncPlugin.start({ warmup, interactive })`:

```ts
const interactiveWarmup =
  options.interactive ?? Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
```

Why: warmup at startup attempts a `syncServer` on every configured server. For uncached `authorization_code` / `device_code` providers, that would try to open a browser or block on device-code polling. In CI or a daemonized run, both stdin and stdout aren't TTYs — so the default falls back to non-interactive, the warmup throws "interactive authentication required", `syncServer` catches the error and preserves cached state. The provider stays in the OpenCode config with whatever models were cached previously (none on cold start).

When a chat request arrives later, `chat.headers` calls `ensureAccessToken` (with no `interactive` option, so it defaults to interactive in `OAuthClient.ensureToken`), and on-demand auth runs.

Override when you know better:

- **`interactive: true`** when running under a process supervisor that doesn't expose a TTY but you do want first-run auth to attempt (rare).
- **`interactive: false`** in CI even on a runner that happens to allocate a pseudo-TTY (some self-hosted runners do) — guarantees no hang on a callback that nobody is going to complete.

`start()` is called from inside the `config` hook with default options; you only override by constructing the runtime yourself (e.g. embedding `OAuth2ModelSyncPlugin` outside OpenCode).

## Cache layout

Source: [`src/cache.ts`](../packages/opencode-oauth2/src/cache.ts).

### Directory

| OS | Path |
| --- | --- |
| macOS | `~/Library/Caches/opencode-oauth2/<cacheNamespace>/` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/opencode-oauth2/<cacheNamespace>/` |
| Windows | `${LOCALAPPDATA:-~/AppData/Local}/opencode-oauth2/<cacheNamespace>/` |

OpenCode-managed runtimes use `cacheNamespace = "opencode-oauth2-model-sync"` (hard-coded in `opencode.ts`); standalone embedders default to `"oauth2-model-sync"` (`validateConfig` default).

Directories are created with `0o700`; cache files with `0o600`. Writes are atomic (write to `.tmp`, then `rename`).

### File shape

One file per server, named `<serverId>.json`:

```json
{
  "serverId": "miaou",
  "updatedAt": 1737000000000,
  "lastSyncAt": 1737000000000,
  "token": {
    "accessToken": "eyJ...",
    "tokenType": "Bearer",
    "refreshToken": "eyJ...",
    "scope": "openid profile",
    "expiresAt": 1737003600000
  },
  "rawModels": [{ "id": "glm-5", "object": "model" }],
  "models": [{ "id": "glm-5", "displayName": "GLM 5" }]
}
```

`token.refreshToken` is **optional** in the file shape — `client_credentials` doesn't issue one. `accessToken` and `tokenType` are required; anything missing those gets the entire `token` field evicted on load (see `hasValidTokenShape`). `models` / `rawModels` survive eviction so a stale-but-known model list stays in OpenCode while re-auth happens.

### Eviction

The plugin never rotates the cache file itself — it overwrites in place. To force re-auth:

```sh
# remove just one server's cached state
rm ~/Library/Caches/opencode-oauth2/opencode-oauth2-model-sync/miaou.json

# nuke everything (all servers, all namespaces)
rm -rf ~/Library/Caches/opencode-oauth2/
```

After deletion, the next `chat.headers` call (or warmup) triggers a fresh acquire. See [local development](./local-development.md#force-reauth) for when you need this.

## Sync scheduler

Source: [`src/scheduler.ts`](../packages/opencode-oauth2/src/scheduler.ts), driven from `OAuth2ModelSyncPlugin.start`.

- One scheduler per server. Interval is `server.syncIntervalMinutes * 60_000` ms; default 60 minutes.
- Each tick calls `syncServer(serverId)` — same path warmup uses, but with no `interactive` override (so it inherits the default behavior of `ensureToken`).
- **Failure handling.** `syncServer` catches every error, logs `sync_failed`, and **does not mutate runtime state**. The previously cached models stay available to OpenCode; the next interval retries.
- If a sync succeeds with a different model set, the cache is updated and OpenCode sees the new models on the next `config` re-run (or immediate if the difference is in display names — those propagate through the merge in `chat.headers`'s opportunistic trigger and the next request).

You don't normally want to disable the scheduler (there's no setting for it). If the upstream catalog is static, the scheduler is cheap — a `/models` GET every hour.

## Logging

Two layers of secret protection:

### Field-name redaction (logger level)

In `src/logging.ts`, `redactFields()` walks the structured-fields object and replaces any field whose key matches `/token|secret|password/i` with `"[redacted]"`. Applied to **every** log entry emitted by the plugin's own logger. So an inadvertently-logged `accessToken: "eyJ..."` becomes `accessToken: "[redacted]"` regardless of where it came from.

### Substring scrubbing (`scrubSecrets`)

In `src/oauth/http-utils.ts`, `scrubSecrets(text)` masks token-shaped substrings inside arbitrary error bodies:

- JSON tokens: `"access_token": "eyJ..."`, `"refresh_token": "..."`, `"id_token": "..."`, `"client_secret": "..."`, plus `client_assertion`, `code`, `device_code`, `password`, `assertion`, `subject_token`, `actor_token`.
- Form bodies: `client_secret=...`, `access_token=...`, etc., terminated by `&` or end-of-string.
- `Authorization` header values: `Bearer <token>`, `Basic <b64>`.
- Bare JWT-shaped strings: `eyJ<base64url>.<base64url>.<base64url>`.

Applied at every `bodyPreview` site:

- `oauth_client_credentials_failed`
- `oauth_jwt_bearer_failed`, `oauth_token_exchange_failed`
- `oauth_device_authorization_failed`, `oauth_device_code_poll_failed`
- `model_discovery_error_body`

So forwarding the plugin's structured logs to a centralized aggregator (Loki, Datadog, etc.) is safe — there's no path where the plugin emits a raw access token through its logger.

### What only goes to stderr

Two paths bypass the structured logger and write directly to `process.stderr` so the **terminal user** can see them, but the values never enter centralized log forwarding:

1. **Browser-open failure during `authorization_code`.** When `openExternalUrl` throws (no display, missing handler), the plugin writes the authorization URL — which contains the `state` nonce — straight to stderr. Logging it through the logger would land the nonce in shared aggregation, which could enable login-CSRF via a forged callback.
2. **Device-code user code + verification URL.** The user needs to read these out of their terminal to complete the flow. They are *also* logged (`oauth_device_code_issued`) — `user_code` is intentionally not redacted because it's an ephemeral single-use code with no value outside the active flow (RFC 8628 §3.2). But stderr is the reliable channel.

### URL redaction (`redactUrl`)

Anywhere the plugin logs a URL it ran (`tokenEndpoint`, `modelsUrl`), it goes through `redactUrl` first, which strips `user:pass@` userinfo, the query string, and the fragment. Configs like `https://user:pass@auth.example.com/realms/foo/token` don't leak credentials into the log.

### Event names you'll actually see

| Event | When | Notable fields |
| --- | --- | --- |
| `plugin_initialized` | first load | `serverCount` |
| `sync_start` | every scheduler tick or warmup | `serverId`, `interactive` |
| `sync_success` | model fetch succeeded | `modelCount`, `added`, `removed`, `renamed` |
| `sync_failed` | any error during sync | `serverId`, `error` (string) |
| `sync_startup_failed` | warmup failed | `serverId`, `error` |
| `oauth_login_started` | `authorization_code` PKCE began | `issuer`, `authorizationEndpoint` |
| `oauth_login_success` / `oauth_login_failed` | PKCE result | |
| `oauth_refresh_success` / `oauth_refresh_failed` | `refresh_token` exchange | |
| `oauth_device_code_issued` | RFC 8628 step 1 succeeded | `verificationUri`, `userCode`, `expiresIn` |
| `oauth_device_code_success` / `oauth_device_code_poll_failed` / `oauth_device_code_poll_transient_error` | RFC 8628 polling | `consecutiveFailures`, `nextIntervalSeconds` on transient |
| `oauth_client_credentials_started` / `_success` / `_failed` | `client_credentials` flow | `tokenEndpoint`, `status`, `bodyPreview` |
| `oauth_jwt_bearer_started` / `_success` / `_failed` | `jwt_bearer` flow | `subjectTokenSource`, `bodyPreview` |
| `oauth_token_exchange_started` / `_success` / `_failed` | `token_exchange` flow | `subjectTokenSource`, `bodyPreview` |
| `oauth_open_browser_failed` | `xdg-open`/`open`/`start` failed | `error` (URL goes to stderr separately) |
| `model_discovery_error_body` | `/v1/models` returned non-2xx | `modelsUrl`, `status`, `bodyPreview` |
| `model_discovery_empty` | `/v1/models` returned 0 models | `modelsUrl` |
| `oauth2_bearer_propagated_to_provider_headers` | bearer stamped onto `options.headers` (config step 6) | `providerId` |
| `oauth2_bearer_propagation_skipped_user_set` | skipped — user already set `Authorization` | `providerId` |
| `oauth2_bearer_propagation_skipped_no_token` | skipped — refresh-only ensure couldn't produce a token without a fresh prompt | `providerId`, `error` |

When OpenCode is the host, the plugin pipes everything through `client.app.log()` *in addition* to stderr (best-effort, non-blocking). Stderr is the reliable channel.

## Token policy (recap)

Refresh tokens are mandatory **for the flows that issue them**:

- `authorization_code`, `device_code`, `refresh_token` responses → must include `refresh_token` (refresh responses can omit it; the previous one is preserved via `fallbackRefreshToken`).
- `client_credentials`, `jwt_bearer`, `token_exchange` → no `refresh_token` requested or stored. Re-authentication is the renewal path.

If a flow that should have returned a refresh token didn't (`authorization_code` against a misconfigured IdP that suppresses `offline_access`), the exchange throws before the token lands in cache.

## Provider ID resolution

In `chat.headers`, the provider id is resolved as `input.model?.providerID ?? input.provider?.info?.id`. The fallback to `provider.info.id` matters when OpenCode flows hand the hook a `model` with an unset `providerID` — older OpenCode versions did this for certain config shapes. With both unset, the hook is a no-op and the request goes out without an `Authorization` header (which would 401 against an OAuth-protected gateway — useful signal in logs).
