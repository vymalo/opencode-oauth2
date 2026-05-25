# Local development

How to iterate on `@vymalo/opencode-oauth2` (or on an opencode setup that uses it) without polluting your shell's `~/.config/opencode/` or fighting cached tokens.

## Sandbox: scoped OpenCode config

OpenCode reads its config from `$OPENCODE_CONFIG_DIR` if set, falling back to its built-in default. Point it at a throwaway directory for the duration of your shell session:

```sh
export OPENCODE_CONFIG_DIR=/tmp/opencode-sandbox
mkdir -p "$OPENCODE_CONFIG_DIR"
```

Write your `opencode.json` there:

```sh
cat > "$OPENCODE_CONFIG_DIR/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugins/opencode-oauth2.ts"],
  "provider": {
    "miaou": {
      "name": "Miaou (local)",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.verif.fyi/realms/camer-digital",
          "clientId": "opencode-local",
          "scopes": ["openid", "profile", "offline_access"],
          "redirectPort": 8765
        }
      }
    }
  }
}
JSON
```

Now `opencode run --model "miaou/glm-5" "..."` uses the sandbox; your real config is untouched.

### Plugin re-export trick

OpenCode loads plugin paths relative to `$OPENCODE_CONFIG_DIR`. To iterate on a locally-checked-out version of the plugin without `npm link`:

```sh
mkdir -p "$OPENCODE_CONFIG_DIR/plugins"
cat > "$OPENCODE_CONFIG_DIR/plugins/opencode-oauth2.ts" <<'TS'
// Re-export so OpenCode treats this as the plugin module while still
// loading code from your local checkout.
export { default } from "/absolute/path/to/lightbridge-opencode/packages/opencode-oauth2/dist/index.js";
TS
```

Build the plugin in watch mode:

```sh
pnpm --filter @vymalo/opencode-oauth2 build --watch
```

Each `opencode run` picks up the latest `dist/`. No reload, no daemon, no install step.

If you'd rather import directly from `src/` (TypeScript), set `"type": "module"` and use OpenCode's TS plugin loader — see the OpenCode plugin docs. The `dist/` re-export is the path of least resistance.

## Fixed `redirectPort` vs random

The plugin defaults to **random** loopback ports for the `authorization_code` callback (`startLocalCallbackServer` listens on `127.0.0.1:0`, then reads the assigned port). The IdP's allowed-redirect-URIs list must accept the resulting URI.

| IdP behavior | Use |
| --- | --- |
| Wildcard loopback: `http://127.0.0.1:*/...` (Auth0, Okta with proper config, Keycloak with `+` in valid redirect URIs) | random — `redirectPort` omitted from config |
| Strict literal redirect URI list (Keycloak default; many enterprise IdPs) | fixed `redirectPort: 8765` (any port that's free locally) + register `http://127.0.0.1:8765/oauth2/callback` in the IdP |

Fixed-port pitfalls:

- If port 8765 is taken (another process bound to it), the plugin throws on `startLocalCallbackServer`. Pick another port and update both ends.
- A fixed port across multiple machines means each machine collides if multiple users authenticate simultaneously — fine for a single-user laptop, not fine for shared infra.

When in doubt, register a small range (e.g. ports 8765–8770) in the IdP and let the plugin pick one. The callback path is hardcoded as `/oauth2/callback`.

## Force re-auth

Delete the cached state. The plugin's cache directory is laid out as `<root>/opencode-oauth2/<namespace>/<serverId>.json` — see [architecture.md](./architecture.md#cache-layout) for the full path table.

macOS:

```sh
# remove just one server's cached state
rm ~/Library/Caches/opencode-oauth2/opencode-oauth2-model-sync/miaou.json

# nuke everything (all servers, all namespaces)
rm -rf ~/Library/Caches/opencode-oauth2/
```

Linux:

```sh
rm ~/.cache/opencode-oauth2/opencode-oauth2-model-sync/miaou.json
# or:
rm -rf ~/.cache/opencode-oauth2/
```

Windows (PowerShell):

```powershell
Remove-Item "$env:LOCALAPPDATA\opencode-oauth2\opencode-oauth2-model-sync\miaou.json"
```

After deletion, the next `opencode run` triggers a fresh acquire (browser launch for `authorization_code`, device-code prompt for `device_code`, etc.).

### When you specifically need to force re-auth

- **Scope changes.** Keycloak's `refresh_token` exchange preserves the **originally granted scopes**, ignoring any new `scope` you pass on the refresh request. Adding a scope to your config takes effect only after a fresh login.
- **Audience changes.** Same logic — re-auth, don't refresh.
- **Switching `authFlow`.** Cached refresh tokens from one flow are usually rejected by the IdP if you flip to another. Delete the cache rather than chasing 401s.
- **IdP-side client changes** (rotated `clientSecret`, changed redirect URIs, revoked sessions): the cached refresh token may be invalidated server-side. Delete + re-auth.

## Dev-only `env` subject-token source

For testing `jwt_bearer` / `token_exchange` flows without a live GitHub Actions runtime or a Kubernetes cluster, hand the plugin a known-good JWT via an environment variable:

```sh
# Get a token however you can — kubectl, an Okta test util, a hand-signed
# JWT from your IdP's admin console. The point is the plugin presents this
# as the subject token, exactly as it would in CI/K8s.
export FAKE_JWT="eyJhbGciOiJSUzI1NiIs..."
```

Config:

```jsonc
{
  "provider": {
    "miaou": {
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.verif.fyi/realms/camer-digital",
          "clientId": "opencode-dev",
          "scopes": ["openid"],
          "authFlow": "jwt_bearer",
          "subjectTokenSource": {
            "type": "env",
            "var": "FAKE_JWT"
          }
        }
      }
    }
  }
}
```

Now `opencode run --model "miaou/glm-5" "..."` exercises the full `jwt_bearer` POST against your real IdP, presenting `FAKE_JWT` as the assertion. Useful for:

- Debugging IdP-side claim mapping / token-exchange policy without spinning up a runner.
- Reproducing 401s observed in CI locally with the same JWT.
- Smoke-testing a new Keycloak client config before pushing to staging.

The `env` source is intentionally not documented for production — it bypasses the platform's identity attestation. Use `github_actions` or `kubernetes_sa` for anything real.

## Useful one-liners

Inspect the current cached state:

```sh
# macOS
cat ~/Library/Caches/opencode-oauth2/opencode-oauth2-model-sync/miaou.json | jq .

# Linux
cat ~/.cache/opencode-oauth2/opencode-oauth2-model-sync/miaou.json | jq .
```

Tail the plugin's JSON logs (when running opencode with stderr redirected):

```sh
opencode run --model "miaou/glm-5" "say hi" 2>&1 \
  | jq -Rr 'fromjson? // .' \
  | grep -E '"event":"(oauth|sync|model)'
```

Run the test suite while iterating:

```sh
pnpm --filter @vymalo/opencode-oauth2 test --watch
```

Hit a single test file:

```sh
pnpm --filter @vymalo/opencode-oauth2 test -- src/oauth/client.test.ts
```
