# @vymalo/opencode-oauth2

OAuth2/OIDC model sync plugin for OpenCode.

## What It Does

- Registers OpenAI-compatible providers into OpenCode config
- Performs OAuth2/OIDC auth code flow with PKCE (or RFC 8628 device authorization grant)
- Supports confidential clients via `clientSecret`
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
| `clientSecret` | _(unset)_ | For confidential clients. Sent as `client_secret` on every token-endpoint POST (auth-code exchange, refresh, device-code poll). Never logged. PKCE is still required for `authorization_code`. |
| `authFlow` | `"authorization_code"` | Set to `"device_code"` for browserless RFC 8628 device authorization grant. The user_code + verification URI are written to the structured logger and to stderr. |
| `deviceAuthorizationEndpoint` | discovered | Override for the device authorization endpoint. Otherwise discovered from `device_authorization_endpoint` in the OIDC metadata. Only used when `authFlow === "device_code"`. |
| `authorizationEndpoint` | discovered | Override for the authorization endpoint. |
| `tokenEndpoint` | discovered | Override for the token endpoint. |
| `redirectPort` | random | Fixed port for the local callback server (authorization-code only). |

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

- `LightbridgeOAuth2ModelSyncPlugin` (default OpenCode plugin export)
- `createLightbridgeOAuth2ModelSyncPlugin()` (factory for testing/custom wiring)
- `OAuth2ModelSyncPlugin` (runtime orchestrator)
