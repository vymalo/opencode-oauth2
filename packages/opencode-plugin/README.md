# @lightbridge/opencode-plugin

OAuth2/OIDC model sync plugin for OpenCode.

## What It Does

- Registers OpenAI-compatible providers into OpenCode config
- Performs OAuth2/OIDC auth code flow with PKCE
- Stores and refreshes provider access tokens
- Fetches and normalizes provider model catalogs
- Injects `Authorization` headers at chat request time

## Install

Add plugin package to OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@lightbridge/opencode-plugin"]
}
```

## Configuration

### Option A: Provider-embedded OAuth config (recommended)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@lightbridge/opencode-plugin"],
  "provider": {
    "example-ai": {
      "name": "Example AI",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "lightbridgeOAuth2": {
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
  "plugin": ["@lightbridge/opencode-plugin"],
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
pnpm --filter @lightbridge/opencode-plugin typecheck
pnpm --filter @lightbridge/opencode-plugin test
pnpm --filter @lightbridge/opencode-plugin build
```

## Exports

- `LightbridgeOAuth2ModelSyncPlugin` (default OpenCode plugin export)
- `createLightbridgeOAuth2ModelSyncPlugin()` (factory for testing/custom wiring)
- `OAuth2ModelSyncPlugin` (runtime orchestrator)
