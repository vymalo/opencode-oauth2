# @vymalo/opencode-oauth2

OAuth2/OIDC model sync plugin for OpenCode. This is the canonical configuration reference for the plugin. Long-form usage guides (CI cookbooks, Kubernetes manifests, troubleshooting) live in [`/docs/`](../../docs/) at the repo root.

## What It Does

- Registers OpenAI-compatible providers into OpenCode config
- Supports five OAuth2 grants:
  - `authorization_code` — interactive PKCE login (default)
  - `device_code` — RFC 8628, for browserless user auth
  - `client_credentials` — machine-to-machine via `clientSecret`
  - `jwt_bearer` — RFC 7523, federated identity (e.g. GitHub Actions OIDC, K8s SA tokens) — no long-lived secret in CI
  - `token_exchange` — RFC 8693, federated identity with explicit audience targeting
- Stores and refreshes provider access tokens
- Fetches and normalizes provider model catalogs
- Injects `Authorization` headers at chat request time

## Install

Add plugin package to OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@vymalo/opencode-oauth2"]
}
```

## Configuration

### Option A: Provider-embedded OAuth config (recommended)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@vymalo/opencode-oauth2"],
  "provider": {
    "example-ai": {
      "name": "Example AI",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.example.com",
          "clientId": "opencode-client",
          "scopes": ["openid", "profile", "offline_access"],
          "syncIntervalMinutes": 60,
          "nameOverrides": {
            "glm-5": "GLM 5"
          }
        }
      }
    }
  }
}
```

### Option B: `pluginConfig.oauth2ModelSync.servers`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@vymalo/opencode-oauth2"],
  "pluginConfig": {
    "oauth2ModelSync": {
      "servers": [
        {
          "id": "example-ai",
          "name": "Example AI",
          "issuer": "https://auth.example.com",
          "baseURL": "https://api.example.com/v1",
          "clientId": "opencode-client",
          "scopes": ["openid", "profile", "offline_access"],
          "syncIntervalMinutes": 60,
          "nameOverrides": {
            "glm-5": "GLM 5"
          }
        }
      ]
    }
  }
}
```

### Optional fields

These apply to both config shapes above.

| Field | Default | Notes |
| --- | --- | --- |
| `clientSecret` | _(unset)_ | For confidential clients. Sent as `client_secret` on every token-endpoint POST. Never logged. Required for `authFlow: "client_credentials"`. Optional but commonly required for `jwt_bearer` / `token_exchange` with confidential clients. PKCE is still required for `authorization_code`. |
| `authFlow` | `"authorization_code"` | One of `"authorization_code"`, `"device_code"`, `"client_credentials"`, `"jwt_bearer"`, `"token_exchange"`. |
| `pkce` | `true` | Send PKCE (`code_challenge` + `code_challenge_method=S256`, replayed as `code_verifier`) on the `authorization_code` and `device_code` flows. Leave it on — compliant servers ignore it, and a Keycloak client with PKCE enforced **requires** it (otherwise the device/authorize request 400s with `Missing parameter: code_challenge_method`). Set `false` only for a non-compliant IdP that rejects the extra parameters. No effect on the machine flows. |
| `subjectTokenSource` | _(required for `jwt_bearer` / `token_exchange`)_ | Where to read the platform JWT to present as the subject token. See [Federated identity](#federated-identity-no-long-lived-secrets-in-ci) below. |
| `tokenExchangeAudience` | _(unset)_ | Optional `audience` parameter for the `token_exchange` grant. |
| `deviceAuthorizationEndpoint` | discovered | Override for the device authorization endpoint. Otherwise discovered from `device_authorization_endpoint` in the OIDC metadata. Only used when `authFlow === "device_code"`. |
| `authorizationEndpoint` | discovered | Override for the authorization endpoint. |
| `tokenEndpoint` | discovered | Override for the token endpoint. |
| `redirectPort` | random | Fixed port for the local callback server (authorization-code only). |
| `nameOverrides` | `{}` | Map of model id → friendly display name. Applied during catalog normalization. |
| `syncIntervalMinutes` | `60` | Per-server scheduler interval. Failures preserve the last-known-good model list. |
| `jwksUri` | _(unset)_ | Reserved; not currently used at runtime. |

Plus the top-level `pluginConfig.oauth2ModelSync` block accepts:

| Field | Default | Notes |
| --- | --- | --- |
| `cacheNamespace` | `"opencode-oauth2-model-sync"` (OpenCode-hosted) / `"oauth2-model-sync"` (standalone) | Subdirectory under the OS cache root. See [architecture.md](../../docs/architecture.md#cache-layout) for the path table per OS. |
| `httpTimeoutMs` | `15000` | Timeout for token-endpoint / `/models` round trips. |
| `tokenExpirySkewMs` | `30000` | Treat a token as expired this many ms before its real `expiresAt`. |

The plugin's log level follows the host's top-level `logLevel` (`"DEBUG" | "INFO" | "WARN" | "ERROR"`) — set it once in your OpenCode config and the plugin honors the same threshold for both console output and forwarded `app.log` records. Defaults to `"info"` when the host doesn't set one.

## Federated identity (no long-lived secrets in CI)

For CI runners and Kubernetes workloads, the modern best practice is to skip stored client secrets entirely and use the platform's own short-lived OIDC token to authenticate. `@vymalo/opencode-oauth2` supports this via the **`jwt_bearer`** (RFC 7523) and **`token_exchange`** (RFC 8693) grants.

The plugin reads the platform JWT at token-acquisition time (never caches it) and presents it to your OAuth server as proof of identity. The OAuth server validates the JWT signature against the platform's JWKS, applies your IdP's policy, and returns an access token.

`subjectTokenSource` tells the plugin where to read the JWT:

| `type` | Reads from | Required fields |
| --- | --- | --- |
| `github_actions` | `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN` env vars | `audience` |
| `kubernetes_sa` | Projected service-account token file (default `/var/run/secrets/tokens/oauth2/token`) | _(optional `tokenPath`)_ |
| `file` | Arbitrary file path | `path` |
| `env` | Environment variable (dev/test only) | `var` |

End-to-end recipes:

- **GitHub Actions** — see [`docs/github-actions.md`](../../docs/github-actions.md) for the Keycloak / Auth0 / Okta setup walkthroughs, the reusable workflow at [`.github/workflows/opencode-run.yml`](../../.github/workflows/opencode-run.yml), matrix builds, audience pinning, and fork-PR limitations.
- **Kubernetes** — see [`docs/kubernetes.md`](../../docs/kubernetes.md) for the `CronJob` (headline), `Job`, and `Deployment` manifests, multi-provider pods, IdP setup with Keycloak/Dex, and RBAC notes (spoiler: you need almost none).

### Quick GHA reference

```jsonc
{
  "provider": {
    "example-ai": {
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.example.com/realms/example",
          "clientId": "ci-runner",
          "scopes": ["openid"],
          "authFlow": "jwt_bearer",
          "subjectTokenSource": {
            "type": "github_actions",
            "audience": "https://auth.example.com/realms/example"
          }
        }
      }
    }
  }
}
```

Workflow needs `permissions: { id-token: write }`. No `clientSecret` anywhere.

### Quick Kubernetes reference

```jsonc
{
  "provider": {
    "example-ai": {
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.example.com/realms/example",
          "clientId": "k8s-runner",
          "scopes": ["openid"],
          "authFlow": "jwt_bearer",
          "subjectTokenSource": {
            "type": "kubernetes_sa"
          }
        }
      }
    }
  }
}
```

The pod must mount a projected `serviceAccountToken` at `/var/run/secrets/tokens/oauth2/token` with the IdP's expected `audience`. The projected token rotates automatically (kubelet refreshes it); the plugin re-reads on every access-token expiry, so rotation is transparent. Full manifests in [`docs/kubernetes.md`](../../docs/kubernetes.md).

### Choosing between `jwt_bearer` and `token_exchange`

- **`jwt_bearer`** is the standard federated grant. Single POST: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<JWT>`. Keycloak, Auth0, Okta all support it. **Start here.**
- **`token_exchange`** (RFC 8693) is more general — supports `subject_token_type`, `actor_token`, `requested_token_type`, and an explicit `audience` claim. Use only when your IdP requires it or when you need the audience targeting (set `tokenExchangeAudience`).

## OAuth Token Requirements

Refresh tokens are mandatory for the flows that issue them (`authorization_code`, `device_code`).

- Initial token exchange for those flows must return `refresh_token`; missing → rejected.
- Cached tokens missing `refreshToken` are invalidated on load (unless the flow doesn't issue one — `client_credentials`, `jwt_bearer`, `token_exchange`).
- Refresh flow preserves the previous refresh token when providers omit it in refresh responses.

## Hooks Used

- `config`: register/patch provider config and merge cached discovered models
- `chat.headers`: ensure valid token and set `Authorization` header

See [architecture.md](../../docs/architecture.md#the-two-hooks) for the full hook semantics.

## Development

```sh
pnpm --filter @vymalo/opencode-oauth2 typecheck
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
```

## Exports

- `OpencodeOauth2Plugin` (default OpenCode plugin export)
- `createOpencodeOauth2Plugin()` (factory for testing / custom wiring)
- `OAuth2ModelSyncPlugin` (runtime orchestrator — useful for embedding outside OpenCode)
