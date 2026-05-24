# Getting Started

This guide shows how to run the plugin locally with OpenCode.

## Prerequisites

- Node.js `20+`
- `pnpm`
- OpenCode CLI installed
- An OAuth2/OIDC provider that:
- supports Authorization Code + PKCE (or the RFC 8628 device authorization grant for headless setups)
- returns a `refresh_token`
- exposes an OpenAI-compatible models endpoint at `{baseURL}/v1/models`

## 1. Build The Plugin

From repo root:

```bash
pnpm install
pnpm --filter @lightbridge/opencode-plugin build
```

## 2. Register It In OpenCode (Local Plugin Mode)

Create a local OpenCode plugin file in your target project:

`<your-project>/.opencode/plugins/lightbridge-oauth2-model-sync.ts`

```ts
import LightbridgeOAuth2ModelSyncPlugin from "/absolute/path/to/lightbridge-opencode/packages/opencode-plugin/dist/index.js";

export default LightbridgeOAuth2ModelSyncPlugin;
```

Use an absolute path to this repository on your machine.

## 3. Configure OpenCode Provider

In your project `opencode.json`, add provider configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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

### Optional fields

- `clientSecret` — for confidential clients; sent with every token POST. Never logged. PKCE still applies.
- `authFlow` — `"authorization_code"` (default) or `"device_code"` for browserless setups (e.g., SSH/CI).
- `deviceAuthorizationEndpoint` — override; otherwise discovered from the OIDC metadata.

## 4. Start OpenCode

Run OpenCode in the project:

```bash
opencode
```

On first use of the configured provider:

- browser opens for OAuth login
- callback is handled locally by the plugin
- model list is fetched and normalized
- bearer token is injected on model requests

## 5. Verify It Works

- Run `/models` and confirm your provider appears.
- Select a discovered model and send a prompt.
- Confirm model names are normalized (`glm-5` -> `GLM 5`).

## Token Requirement

Refresh token support is mandatory:

- access-only OAuth tokens are rejected
- cached tokens without `refreshToken` are ignored
- refresh flow preserves old refresh token if the refresh response omits it

## Useful Commands

```bash
pnpm --filter @lightbridge/opencode-plugin typecheck
pnpm --filter @lightbridge/opencode-plugin test
pnpm --filter @lightbridge/opencode-plugin build
```

