# @vymalo/opencode-oauth2

OAuth2/OIDC model sync plugin for OpenCode.

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
| `subjectTokenSource` | _(required for `jwt_bearer` / `token_exchange`)_ | Where to read the platform JWT to present as the subject token. See [Federated identity](#federated-identity-no-long-lived-secrets-in-ci) below. |
| `tokenExchangeAudience` | _(unset)_ | Optional `audience` parameter for the `token_exchange` grant. |
| `deviceAuthorizationEndpoint` | discovered | Override for the device authorization endpoint. Otherwise discovered from `device_authorization_endpoint` in the OIDC metadata. Only used when `authFlow === "device_code"`. |
| `authorizationEndpoint` | discovered | Override for the authorization endpoint. |
| `tokenEndpoint` | discovered | Override for the token endpoint. |
| `redirectPort` | random | Fixed port for the local callback server (authorization-code only). |

## Federated identity (no long-lived secrets in CI)

For CI runners and Kubernetes workloads, the modern best practice is to skip stored client secrets entirely and use the platform's own short-lived OIDC token to authenticate. `@vymalo/opencode-oauth2` supports this via the **`jwt_bearer`** (RFC 7523) and **`token_exchange`** (RFC 8693) grants.

The plugin reads the platform JWT at token-acquisition time (never caches it) and presents it to your OAuth server as proof of identity. The OAuth server validates the JWT signature against the platform's JWKS, applies your IdP's policy, and returns an access token.

`subjectTokenSource` tells the plugin where to read the JWT:

| `type` | Reads from | Required fields |
| --- | --- | --- |
| `github_actions` | `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN` env vars | `audience` |
| `kubernetes_sa` | Projected service-account token file (default `/var/run/secrets/tokens/oauth2/token`) | _(optional `tokenPath`)_ |
| `file` | Arbitrary file path | `path` |
| `env` | Environment variable | `var` |

### GitHub Actions

**1. Register the workflow's OIDC identity with your OAuth server.** For Keycloak, add an Identity Provider of type "OpenID Connect" with:
- Issuer: `https://token.actions.githubusercontent.com`
- Audience: an identifier you choose (used below as `audience`)
- Map claims so a specific `repository:` / `workflow:` subject can mint a token for your client

Auth0, Okta, and similar all support the same flow — see your IdP's docs for "trust GitHub Actions OIDC tokens".

**2. Set up the workflow:**

```yaml
name: AI-assisted job

on:
  workflow_dispatch:

permissions:
  id-token: write   # required — lets the runner mint an OIDC token
  contents: read

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          # opencode + plugin must be installed first; here as an example
          npm install -g opencode @vymalo/opencode-oauth2
      - run: opencode run --model "example-ai/glm-5" "summarize the diff"
        env:
          OPENCODE_CONFIG_DIR: ${{ github.workspace }}/.opencode-ci
```

**3. Provide the opencode config** (e.g. `.opencode-ci/opencode.json`):

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

**No `clientSecret` anywhere.** The runner presents its short-lived OIDC token; your OAuth server trusts it because you configured GHA as an IdP. The plugin re-fetches the OIDC token on each access-token expiry (cheap and automatic).

### Kubernetes ServiceAccount Job

**1. Register the cluster's OIDC issuer with your OAuth server** (same as the GHA setup — add an Identity Provider with the cluster's discovery URL).

**2. Mount a projected service-account token** with your OAuth server as the audience:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: opencode-ai-task
spec:
  template:
    spec:
      serviceAccountName: opencode-runner
      restartPolicy: Never
      containers:
        - name: runner
          image: ghcr.io/your-org/opencode-with-plugin:latest
          env:
            - name: OPENCODE_CONFIG_DIR
              value: /etc/opencode
          command: ["opencode", "run", "--model", "example-ai/glm-5", "summarize the day"]
          volumeMounts:
            - name: oauth2-token
              mountPath: /var/run/secrets/tokens/oauth2
              readOnly: true
            - name: opencode-config
              mountPath: /etc/opencode
              readOnly: true
      volumes:
        - name: oauth2-token
          projected:
            sources:
              - serviceAccountToken:
                  path: token
                  # MUST match the IdP's expected audience exactly.
                  audience: https://auth.example.com/realms/example
                  expirationSeconds: 3600
        - name: opencode-config
          configMap:
            name: opencode-config
```

**3. The ConfigMap holds the opencode config:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencode-config
data:
  opencode.json: |
    {
      "$schema": "https://opencode.ai/config.json",
      "plugin": ["@vymalo/opencode-oauth2"],
      "provider": {
        "example-ai": {
          "name": "Example AI",
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

The projected token at `/var/run/secrets/tokens/oauth2/token` rotates automatically (kubelet refreshes it). The plugin re-reads on every access-token expiry, so rotation is transparent.

**Note:** the default `subjectTokenSource.tokenPath` is `/var/run/secrets/tokens/oauth2/token`. Override it via `"tokenPath": "..."` if your projected mount uses a different path.

### Choosing between `jwt_bearer` and `token_exchange`

- **`jwt_bearer`** is the standard federated grant. Single POST: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<JWT>`. Keycloak, Auth0, Okta all support it. **Start here.**
- **`token_exchange`** (RFC 8693) is more general — supports `subject_token_type`, `actor_token`, `requested_token_type`, and an explicit `audience` claim. Use only when your IdP requires it or when you need the audience targeting (set `tokenExchangeAudience`).

## OAuth Token Requirements

Refresh token support is mandatory.

- Initial token exchange must return `refresh_token`.
- Cached tokens missing `refreshToken` are invalidated.
- Refresh flow preserves the previous refresh token when providers omit it in refresh responses.

## Hooks Used

- `config`: register/patch provider config and merge cached discovered models
- `chat.headers`: ensure valid token and set `Authorization` header

## Development

```bash
pnpm --filter @vymalo/opencode-oauth2 typecheck
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
```

## Exports

- `OpencodeOauth2Plugin` (default OpenCode plugin export)
- `createOpencodeOauth2Plugin()` (factory for testing / custom wiring)
- `OAuth2ModelSyncPlugin` (runtime orchestrator — useful for embedding outside OpenCode)
