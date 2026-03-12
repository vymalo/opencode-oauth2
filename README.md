# lightbridge-opencode

OpenCode plugin workspace for OAuth2-secured, OpenAI-compatible provider syncing.

This project implements an OpenCode plugin that:

- authenticates with OAuth2/OIDC (Authorization Code + PKCE)
- discovers models from `/v1/models`
- normalizes model names for display
- keeps model metadata cached and synced
- injects bearer tokens via OpenCode `chat.headers` hook

## Workspace

- `packages/opencode-plugin`: runtime plugin implementation
- `packages/plugin-bundle`: bundling/package assembly scaffold
- `packages/native-core`: optional Rust native scaffold
- `plans/prd.md`: product requirements and implementation phases

## Quick Start (Development)

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm --filter @lightbridge/opencode-plugin test
```

## OpenCode Usage

The plugin can be configured in two ways:

1. Provider-embedded options (`provider.<id>.options.lightbridgeOAuth2`)
2. PRD-style plugin section (`pluginConfig.oauth2ModelSync.servers`)

Detailed configuration examples are in:

- `packages/opencode-plugin/README.md`
- `GETTING_STARTED.md`

## Token Policy

This plugin enforces refresh-token-based OAuth sessions.

- Access tokens without a refresh token are rejected.
- Cached tokens missing `refreshToken` are ignored.
- Refresh responses that omit `refresh_token` reuse the existing refresh token.

## Status

Current implementation includes the Phase 1 scaffold and initial Phase 2 runtime core.
