# opencode-oauth2

> Bring your own OAuth-protected LLM gateway to [OpenCode](https://opencode.ai).

An [OpenCode](https://opencode.ai) plugin that lets you wire up **OpenAI-compatible model providers sitting behind OAuth2 / OIDC** — without baking long-lived API keys into your config. Discover models dynamically, refresh tokens automatically, and let OpenCode talk to your gateway as if it were any other provider.

![status: early](https://img.shields.io/badge/status-early-orange)
![node: >=20](https://img.shields.io/badge/node-%3E%3D20-339933)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)
![pnpm workspace](https://img.shields.io/badge/pnpm-workspace-F69220)

---

## Why

Most OpenCode providers assume a static bearer key. That works for hosted SaaS, but breaks down the moment you put your models behind:

- a corporate Identity Provider (Keycloak, Auth0, Okta, Azure AD, …)
- a self-hosted gateway with short-lived tokens
- a multi-tenant setup where each user authenticates as themselves

This plugin closes that gap. It handles the **Authorization Code + PKCE** dance, caches tokens, refreshes them silently, and feeds OpenCode a normal-looking provider with a fresh `Authorization` header on every request.

## Features

- **OAuth2 / OIDC** login via Authorization Code + PKCE
- **Dynamic model discovery** from `/v1/models` (no hand-maintained model lists)
- **Display-name normalization** so `glm-5` shows up as `GLM 5`
- **Persistent token cache** with automatic refresh
- **`chat.headers` hook** injects bearer tokens per request
- **Strict refresh-token policy** — access-only tokens are rejected by design
- **Two configuration styles**: per-provider options or a top-level plugin block

## Install

In your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@vymalo/opencode-oauth2"]
}
```

Then declare a provider:

```jsonc
{
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
          "syncIntervalMinutes": 60
        }
      }
    }
  }
}
```

See [packages/opencode-oauth2/README.md](packages/opencode-oauth2/README.md) for the full configuration reference (including the alternative `pluginConfig.oauth2ModelSync.servers` layout).

## Token Policy

Refresh tokens are **mandatory** — not a nicety.

- Access tokens returned without a `refresh_token` are rejected at exchange time.
- Cached tokens missing `refreshToken` are evicted on load.
- Refresh responses that omit a new `refresh_token` re-use the existing one.

The intent: a session is either fully renewable or it doesn't get cached. No silent fallbacks to short-lived tokens that fail mid-conversation.

## Workspace Layout

This is a [pnpm](https://pnpm.io) monorepo.

| Package | Purpose |
| --- | --- |
| [`packages/opencode-oauth2`](packages/opencode-oauth2) | The runtime plugin — published as `@vymalo/opencode-oauth2` |
| [`packages/plugin-bundle`](packages/plugin-bundle) | Rolldown-based bundling for distribution |
| [`plans/prd.md`](plans/prd.md) | Product requirements and phased roadmap |

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Plugin-only iteration:

```bash
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
```

For end-to-end usage against a local OpenCode install, see [GETTING_STARTED.md](GETTING_STARTED.md).

## Status

Early but functional. The Phase 1 scaffold and Phase 2 runtime core are in; bundling (Phase 3) has landed. Public API may still shift before `1.0`.

Roadmap and phase breakdown live in [plans/prd.md](plans/prd.md).

## Contributing

Issues and PRs are welcome. Please open an issue first for substantial changes so we can align on scope before code review.

## License

[MIT](LICENSE) © vymalo contributors
