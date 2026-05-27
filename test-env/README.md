# test-env

Reusable Docker Compose stack of backends that this workspace's plugins talk to during **integration** tests. Designed so each package can run real-network tests against fixed, scriptable services instead of mocking `fetch` — and so the same env is shared across every package in the monorepo.

## Services

| Service | Image | Host port | What it fakes |
| --- | --- | --- | --- |
| `wiremock` | `wiremock/wiremock:3.9.1` | `18080` | OpenRouter-shaped `/v1/models` endpoint for `@vymalo/opencode-models-info`. ETag-aware (`If-None-Match: "openrouter-v1"` → `304`) and has an `?auth=required` variant that demands a `Bearer` header. |
| `keycloak` _(placeholder, commented out)_ | `quay.io/keycloak/keycloak:25.0` | `18081` | OIDC server for the upcoming `@vymalo/opencode-oauth2` integration suite. Uncomment in `docker-compose.yml` and drop a realm export under `test-env/keycloak/` to wire it up. |

## Quick start

```sh
# bring the stack up
pnpm test:env:up

# run integration tests for the models-info package
pnpm --filter @vymalo/opencode-models-info test:integration

# tear down (and wipe volumes)
pnpm test:env:down
```

Or one-shot — orchestrates compose-up, the integration suites in every package, then compose-down:

```sh
pnpm test:integration
```

## Endpoints when the stack is up

- `http://127.0.0.1:18080/v1/models` — OpenRouter-shaped catalog (3 models). Returns `ETag: "openrouter-v1"`.
- `http://127.0.0.1:18080/v1/models` with `If-None-Match: "openrouter-v1"` — `304 Not Modified`.
- `http://127.0.0.1:18080/v1/models?auth=required` — `401` unless an `Authorization: Bearer …` header is present.
- `http://127.0.0.1:18080/__admin/health` — WireMock's liveness probe. CI scripts wait on this.
- `http://127.0.0.1:18080/__admin/requests` — request journal; handy for debugging.

## Editing stubs

The stubs live in [`wiremock/mappings/`](wiremock/mappings/) (request→response definitions) and [`wiremock/__files/`](wiremock/__files/) (response bodies). They're mounted **read-only** into the container — after editing, either `docker compose restart wiremock` or `curl -X POST http://127.0.0.1:18080/__admin/mappings/reset` to reload.

## Why not testcontainers?

Compose gives every package the same backends with no per-package wiring, and the env is also reachable from `curl`, browsers, and a debugger — useful when an integration test misbehaves. If a specific test needs ad-hoc lifecycle control later, layering testcontainers on top of an already-running compose stack is straightforward.
