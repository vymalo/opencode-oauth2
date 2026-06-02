# Troubleshooting

Symptom-keyed. Each entry covers what's happening internally, where to look in logs, and a diagnostic you can run.

The plugin emits structured JSON logs to stderr (and through `client.app.log()` when running under OpenCode). Anywhere this guide says "look for `<event>` in the logs", that's an event name in the `event` field of those entries — see [architecture.md → Logging](./architecture.md#logging) for the full table.

## `/models` doesn't list my provider after install

**What's happening.** The plugin loaded fine, but warmup at config-hook time ran non-interactively (CI, no TTY, or `interactive: false`) and the cache was empty. `ensureToken` threw `interactive authentication required`; `syncServer` caught it, logged `sync_startup_failed`, and preserved the empty cache. The provider stays registered in OpenCode's config but with no models attached, so the model list is empty.

**Look for.**

- `plugin_initialized` — confirms the plugin loaded.
- `sync_startup_failed` with `error: "interactive authentication required for server ..."` — confirms warmup gave up non-interactively.
- Absence of `sync_success` and `model_discovery_*`.

**Fix.** Trigger auth via an actual `opencode run` (the chat path calls `ensureToken` with `interactive: true` by default), or override warmup interactivity at start time. There's no `pluginConfig` knob for this — if you're embedding the runtime yourself, pass `interactive: true` to `start()`. From the OpenCode-hosted path, you can't override; just run a one-shot to bootstrap.

```sh
# Bootstrap auth interactively — completes the PKCE browser dance once,
# leaves a refresh token in cache for subsequent non-interactive runs.
opencode run --model "miaou/glm-5" "hello"
```

After that, the model list should populate within one scheduler tick (default 60 minutes) or on the next `opencode` restart (warmup picks up the cached refresh token and refreshes silently).

## `redirect_uri_mismatch` from the IdP during PKCE login

**What's happening.** The plugin started a loopback callback server on some `127.0.0.1:<port>`, set `redirect_uri=http://127.0.0.1:<port>/oauth2/callback` in the authorize URL, and the IdP rejected the value because it's not in the client's allowed-redirect-URI list.

**Look for.** The error surfaces in the browser, not the logs — the IdP returns it to the user before the callback runs. The plugin's `oauth_login_started` event will be present; `oauth_login_success` will not.

**Fix per IdP.**

| IdP | Add to allowed redirect URIs |
| --- | --- |
| Keycloak | `http://127.0.0.1:*/oauth2/callback` (with `+` wildcard enabled at realm level) **or** pin `redirectPort: 8765` and add `http://127.0.0.1:8765/oauth2/callback` literally |
| Auth0 | `http://localhost` is implicitly allowed for native apps; for explicit registration, pin `redirectPort` and add `http://127.0.0.1:<port>/oauth2/callback` to *Allowed Callback URLs* |
| Okta | Pin `redirectPort` and add `http://127.0.0.1:<port>/oauth2/callback` to *Sign-in redirect URIs* on the OIDC app |

The plugin's callback path is hard-coded as `/oauth2/callback`. The host is always `127.0.0.1` (not `localhost`) — register the literal `127.0.0.1`, not its DNS alias.

See [local-development.md → Fixed redirectPort vs random](./local-development.md#fixed-redirectport-vs-random) for the tradeoffs.

## `Missing parameter: code_challenge_method` (HTTP 400) on login

**What's happening.** The IdP requires PKCE on the flow you're using, and the request reached it without a `code_challenge`. Most common on **Keycloak** clients where *Advanced → Proof Key for Code Exchange Code Challenge Method* is set to `S256` — Keycloak then enforces PKCE on **both** the authorize endpoint (`authorization_code`) and the device-authorization endpoint (`device_code`).

**Look for.**

- `oauth_device_authorization_failed` with `status: 400` and `bodyPreview` containing `"error":"invalid_request","error_description":"Missing parameter: code_challenge_method"`, followed by `sync_failed` (`device authorization request failed (400)`).
- The equivalent on `authorization_code` surfaces in the browser at the authorize step.

**Fix.** The plugin sends PKCE on both interactive flows **by default**, so on a current version this just works — upgrade if you're on an older build that omitted it. The `code_verifier` is generated per login and replayed on the token exchange/poll automatically; no configuration is needed.

If you're hitting the *opposite* problem — a non-compliant IdP that rejects the extra `code_challenge` / `code_verifier` parameters — set `pkce: false` on that server's `oauth2` options to opt out. Leave it on (the default) for everything else; compliant servers that don't require PKCE simply ignore it.

## `model discovery failed (403)` after auth succeeded

**What's happening.** OAuth succeeded — you have a valid access token — but the upstream `/v1/models` endpoint returned 403. The access token is missing the scope or audience the gateway expects.

**Look for.**

- `oauth_*_success` events present (proves auth worked).
- `sync_failed` with `error: "model discovery failed (403) at https://api.example.com/v1/models"`.
- `model_discovery_error_body` with `status: 403` and a `bodyPreview` (token-shaped substrings are masked by `scrubSecrets`).

**Diagnose.** Copy the access token from the cache and curl `/v1/models` directly:

```sh
# Pull the access token from the cache (replace with your platform's path).
token=$(jq -r .token.accessToken \
  ~/Library/Caches/opencode-oauth2/opencode-oauth2-model-sync/miaou.json)

# Hit /v1/models with it.
curl -i \
  -H "Authorization: Bearer $token" \
  -H "Accept: application/json" \
  https://api.example.com/v1/models
```

If you get the same 403, decode the JWT to inspect the claims:

```sh
# Decode the payload (middle segment).
echo "$token" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

Compare:

- **`scope`** (or `scp` — depends on IdP) against what your gateway requires. Adjust `scopes:` in `opencode.json` and force re-auth (see [local-development.md → Force re-auth](./local-development.md#force-reauth)).
- **`aud`** against what your gateway validates. For `token_exchange`, set `tokenExchangeAudience` to match.

## `models_info_fetch_failed_no_cache` (HTTP 401) — metadata not enriched

**What's happening.** `@vymalo/opencode-models-info` tried to fetch `meta.modelsInfoUrl`, the endpoint returned 401, and there was no previously-cached catalog to fall back to — so model metadata (context window, cost, modalities) is left un-enriched. The metadata endpoint is auth-protected and no `Authorization` header reached it.

**Look for.**

- `models_info_fetch_failed_no_cache` with the `url` and `error: "HTTP 401"`.
- For an oauth2-backed provider: `sync_success` for the provider *did* fire (so inference auth works), but the metadata fetch still 401'd.

**Fix.**

1. **List `@vymalo/opencode-oauth2` before `@vymalo/opencode-models-info`** in your `plugin` array. oauth2's `config` hook stamps the bearer onto `options.headers` and must run first. The bearer is now produced by a refresh-backed ensure, so a freshly-minted (even short-lived) token is propagated rather than skipped.
2. **On a one-off first-login 401, just re-run the command.** The token is on disk after the first login, so the next run stamps it before models-info's hook runs.
3. **Different credential for metadata?** Set `meta.modelsInfoHeaders.Authorization` — it overrides the inherited provider header.
4. **Endpoint not actually OpenRouter-shaped?** A vanilla `/v1/models` returns no mappable fields; point `modelsInfoUrl` at the richer metadata route. See [models-info.md → URL resolution](./models-info.md#url-resolution).

The cache TTL is already 24h by default (`meta.modelsInfoTtlSeconds`); once the fetch 200s once, reboots stay offline for the day. There's no way to pre-seed a placeholder cache for an endpoint that has never succeeded — see [models-info.md → "There's no cache yet"](./models-info.md#theres-no-cache-yet--can-i-get-a-1-day-ttl-entry).

## Cost / limits don't appear in the OpenCode UI despite `models_info_enriched`

**What's happening.** Enrichment worked — `models_info_enriched` reports `enrichedCount > 0` and the `cost` is present in OpenCode's resolved config — but the TUI shows no price or context window. The usual cause is a **missing `limit`**: your metadata endpoint returns `pricing` but no `context_length` / `top_provider`, so the plugin emits no `limit` (it never fakes one), and OpenCode backfills the runtime model's required `limit` to `{ context: 0, output: 0 }`. OpenCode's model UI is built around its `models.dev` catalog where every model has a real limit, so a `0/0` model is treated as incomplete and may suppress the cost line along with the limit.

**Confirm.** Start the headless server (`opencode serve` — it prints a base URL) and inspect the resolved config:

```sh
curl -s http://127.0.0.1:<port>/config/providers \
  | jq '.providers[] | select(.id=="<provider-id>") | .models["<model-id>"] | {cost, limit}'
```

`cost` populated + `limit: { context: 0, output: 0 }` is the signature of this case — proof the plugin did its job and the gap is the source data.

**Fix (server-side).** This is **not** a plugin issue — the metadata endpoint must include the size fields the mapper reads ([`mapping.ts`](../packages/opencode-models-info/src/mapping.ts) — `context` ← `top_provider.context_length ?? context_length`, `output` ← `top_provider.max_completion_tokens`):

```jsonc
{
  "id": "your-model",
  "pricing": { "prompt": "0.0000006", "completion": "0.0000021" },
  "context_length": 128000,
  "top_provider": { "context_length": 128000, "max_completion_tokens": 8192 }
}
```

Once both `context` and `output` are known, the plugin emits a real `limit`, and the cost/limit render in the UI. (`cost` was already correct — adding the limit is what makes both visible.)

## `oauth_client_credentials_failed` 401 with `invalid_client`

**What's happening.** The IdP rejected the `client_id` + `client_secret` combination. Three common root causes for Keycloak; similar elsewhere.

**Look for.**

- `oauth_client_credentials_failed` with `status: 401` and `bodyPreview` containing `invalid_client` or `unauthorized_client`.
- The `bodyPreview` will have token-shaped values masked, but the `error` and `error_description` fields are usually preserved.

**Diagnose (Keycloak).**

1. **Service accounts disabled.** In Keycloak admin: *Clients → \<your client> → Capability config*. Ensure **Service accounts roles** is **on**. Without it, the client cannot use `client_credentials` regardless of secret validity.
2. **Wrong secret.** *Credentials* tab → confirm the secret matches `clientSecret` in your config. Rotated secrets in Keycloak invalidate the previous one immediately.
3. **Client type mismatch.** A *Public* client (no secret) cannot use `client_credentials`. Convert to *Confidential* in *Capability config → Client authentication: ON*.

Reproduce manually:

```sh
curl -i -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT&client_secret=YOUR_SECRET" \
  https://auth.example.com/realms/your-realm/protocol/openid-connect/token
```

A 200 here with an access token means the issue is in your config (typo in `clientId`/`tokenEndpoint`); a 401 with the same body confirms it's an IdP-side misconfig.

## `jwt_bearer` 401 — IdP rejects the assertion

**What's happening.** The IdP received the JWT (subject token) but rejected it. Causes from most to least common:

1. **`aud` mismatch.** The IdP expects a specific audience in the assertion; what you sent doesn't match.
2. **IdP-trust client misconfigured.** Keycloak's GitHub Actions identity provider has `Issuer URL` ≠ the literal `iss` in the JWT, or a *Token Exchange permission* policy that doesn't allow the requesting client.
3. **JWT expired.** GitHub Actions OIDC tokens are valid for ~10 minutes; if the plugin caches an expired one (shouldn't happen — `resolveSubjectToken` always re-fetches) or your clock skew is severe, the assertion fails signature validation.

**Look for.**

- `oauth_jwt_bearer_failed` with `status: 401` and `bodyPreview` containing `invalid_grant` or `invalid_token` and an error description like `assertion is expired` / `audience does not match`.

**Diagnose.** Look up the configured audience and the JWT's `aud`:

```sh
# In a GHA job — manually fetch the OIDC token and decode it.
oidc_token=$(curl -sS \
  -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://your-expected-audience" \
  | jq -r .value)
echo "$oidc_token" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{aud, iss, sub, repository, workflow}'
```

For `kubernetes_sa`:

```sh
# From inside the pod.
jwt=$(cat /var/run/secrets/tokens/oauth2/token)
echo "$jwt" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{aud, iss, sub}'
```

`aud` must match the IdP's expected audience exactly. See [github-actions.md → audience pinning](./github-actions.md#audience-pinning) and [kubernetes.md → IdP setup](./kubernetes.md#idp-setup-keycloak--dex).

## Headless context hangs on first run

**What's happening.** Stdin or stdout reports as a TTY when it isn't (some terminal multiplexers, broken PTY libs, certain CI runners with `tty: true` set). Warmup believes it's interactive, tries to open a browser or start device-code polling, and waits forever for a callback that never arrives.

**Look for.** `oauth_login_started` event but no `oauth_login_success` for several minutes. Process hangs at startup.

**Fix.** Currently no environment-variable override. If you're embedding the runtime, pass `interactive: false` to `start()`. If you're running under OpenCode-hosted mode and can't avoid the misdetection, set `CI=true` in the environment — most TTY-detection libs treat that as a signal to fake non-TTY behavior, though the plugin itself reads `process.stdin.isTTY` directly so this is only effective insofar as your shell or process supervisor honors it.

The principled fix on the embedder side:

```ts
import { OAuth2ModelSyncPlugin } from "@vymalo/opencode-oauth2/lib";
const runtime = new OAuth2ModelSyncPlugin(cfg, { /* ... */ });
await runtime.initialize();
await runtime.start({ warmup: true, interactive: false });
```

If you're stuck on the OpenCode-hosted path, the workaround is "delete the cache and run a one-shot `opencode run` from a real terminal to populate it, then resume the headless context which will refresh silently".

## Tokens not rotating in long-running pod

**What's happening.** The pod's projected SA token rotates fine (kubelet refreshes the file), but the access token from your IdP isn't rotating — same access token keeps being used past its expiry, eventually 401-ing against the upstream.

**Look for.**

- `oauth_jwt_bearer_success` with `hasExpiry: false` — the IdP isn't returning `expires_in`, so the plugin treats undefined-expiry as INVALID for machine flows (it should re-acquire every call). If you see this *and* persistent 401s, the problem is downstream.
- `oauth_jwt_bearer_failed` shortly after a successful auth: confirms re-auth is being attempted and failing.

**Most common root causes.**

1. **Missing `audience` on the projected token volume.** Without it, the SA token's `aud` defaults to the apiserver, not your IdP. The IdP rejects with `audience mismatch`. Fix: add `audience: <idp-audience>` to the `serviceAccountToken` source — see [kubernetes.md](./kubernetes.md#cronjob--scheduled-ai-task).
2. **Audience mismatch between `serviceAccountToken.audience` and `subjectTokenSource.audience`.** For `kubernetes_sa`, the plugin doesn't pass an `audience` to the IdP — the IdP reads it from the JWT itself. Make sure the SA-token's audience equals the IdP's expected audience.
3. **For GHA: missing `audience` in `subjectTokenSource`.** The `github_actions` source *does* set `audience` on the OIDC request URL — but if you've configured a different `audience` than your IdP expects, the resulting JWT will have the wrong `aud`. Both sides need to agree.

Diagnose by tailing logs and counting:

```sh
kubectl logs deploy/opencode-bot --tail=200 \
  | jq -Rr 'fromjson? // empty' \
  | jq -s 'group_by(.event) | map({event: .[0].event, count: length})'
```

If `oauth_jwt_bearer_started` count grows steadily but `oauth_jwt_bearer_success` plateaus, you have a failing re-auth.

## Provenance badge missing on npm

**What's happening.** The published package on npmjs.com is missing the "Built and signed on GitHub Actions" badge. Either the publish workflow didn't request OIDC, or npm rejected the provenance attestation.

**Look for.**

- In the workflow run logs (`Publish to npm` step): any line mentioning `provenance` and `error`.
- On the npm package page: the badge near the version.

**Causes.**

1. **`id-token: write` not granted to the job.** npm provenance generation requires OIDC. Confirm the `permissions:` block on the publish job includes `id-token: write`. The shipped [publish.yml](../.github/workflows/publish.yml) sets it at the workflow level — if you derived your own from an earlier version, double-check.
2. **`repository` field in `package.json` doesn't match the publishing workflow's repo.** npm validates the provenance attestation's repo URL against `package.json` `"repository"`. Mismatch → rejected. Fix:

   ```json
   {
     "repository": {
       "type": "git",
       "url": "git+https://github.com/vymalo/opencode-oauth2.git"
     }
   }
   ```
3. **`NPM_CONFIG_PROVENANCE` not set.** The shipped workflow sets it as a belt-and-braces — if you removed the env var, pnpm's `publish --provenance` flag should still work, but some pnpm/npm version combinations silently drop the flag.

Once fixed, the badge appears on the next published version (you can't backfill provenance for an already-published tarball).

## `[ERR_PNPM_IGNORED_BUILDS]` on CI install

**What's happening.** pnpm 11 enforces an opt-in `allowBuilds` list for native build scripts. If your project pulls in a transitive dep with a postinstall build (esbuild, msgpackr-extract, etc.) and `pnpm-workspace.yaml` doesn't allow it, pnpm fails the install on CI with this error.

**Look for.** Install step output:

```
ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild.
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

**Fix.** Add the package name to `allowBuilds` in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
  msgpackr-extract: true
```

The shipped `pnpm-workspace.yaml` allows these two by default (they're dependencies of vitest/vite + msgpack speedups). If you add a new dep that triggers the same error, audit the package's postinstall script before adding it — `allowBuilds` is the supply-chain-security gate.

**Why pnpm 11's behavior matters.** The legacy `onlyBuiltDependencies` array is silently ignored in `--frozen-lockfile` mode. A local `pnpm install` succeeds because pnpm interactively prompts; CI fails because there's no TTY. Always use `allowBuilds` (the explicit object shape) to keep dev and CI consistent.

## Generic: see exactly what the plugin is doing

Pretty-print and filter the JSON logs:

```sh
opencode run --model "miaou/glm-5" "say hi" 2>&1 \
  | jq -Rr 'fromjson? // .' \
  | jq 'select(.event | test("oauth|sync|model"))'
```

If you don't see anything OAuth-related at all, the plugin isn't loading. Confirm:

```sh
opencode --version
npm ls -g | grep opencode-oauth2
cat $OPENCODE_CONFIG_DIR/opencode.json | jq '.plugin'
```

The `plugin` array must include `"@vymalo/opencode-oauth2"` (or a local path that re-exports it — see [local-development.md](./local-development.md#plugin-reexport-trick)).
