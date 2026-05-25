# `vymalo/opencode-oauth2/.github/actions/setup`

Composite GitHub Action that installs [`@vymalo/opencode-oauth2`](https://www.npmjs.com/package/@vymalo/opencode-oauth2) (and optionally the `opencode` CLI) into the runner's global `node_modules`, with cross-run caching so the install runs once per version.

## Why

When you use OpenCode in CI — e.g. an AI-assisted job that runs `opencode run --model ...` — you don't want to pay for a full `pnpm install` of your repo just to make the plugin available. This action does the minimum: one cached `npm install -g` of the plugin (and CLI, if you ask for it), then exports `NODE_PATH` so OpenCode finds the plugin no matter where you `cd` to.

On a cache hit the install step is skipped entirely.

## Usage

### Minimal — plugin only (you already have `opencode` installed)

```yaml
- uses: vymalo/opencode-oauth2/.github/actions/setup@v0.2.0
  with:
    node-version: '22'
```

### Plugin + opencode CLI

```yaml
- uses: vymalo/opencode-oauth2/.github/actions/setup@v0.2.0
  with:
    node-version: '22'
    install-opencode: 'true'
```

### Full federated-identity job (no long-lived secrets)

```yaml
name: AI-assisted job

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: vymalo/opencode-oauth2/.github/actions/setup@v0.2.0
        with:
          node-version: '22'
          install-opencode: 'true'

      - run: opencode run --model "example-ai/glm-5" "summarize the diff"
        env:
          OPENCODE_CONFIG_DIR: ${{ github.workspace }}/.opencode-ci
```

The `OPENCODE_CONFIG_DIR` should contain an `opencode.json` like the one in the [federated identity section](../../../packages/opencode-oauth2/README.md#federated-identity-no-long-lived-secrets-in-ci) of the package README.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `version` | `latest` | Plugin version (`"0.2.0"`, `"^0.2.0"`, `"next"`, …). |
| `install-opencode` | `false` | Also install the opencode CLI globally. |
| `opencode-package` | `opencode-ai` | npm package name for the CLI. Override for forks/mirrors. |
| `opencode-version` | `latest` | CLI version. Only used when `install-opencode=true`. |
| `node-version` | _(unset)_ | If set, runs `actions/setup-node@v4` with this version first. |
| `cache` | `true` | Cache the global install between runs. |

## Outputs

| Name | Description |
| --- | --- |
| `version` | Resolved plugin version that was installed. |
| `opencode-version` | Resolved CLI version (empty if `install-opencode=false`). |
| `node-path` | Absolute path to the global `node_modules`. Also exported as `NODE_PATH`. |
| `cache-hit` | `"true"` when the install was restored from cache. |

## Pinning

Pin to a release tag (`@v0.2.0`) — the action ships with the plugin in the same repo, so the tag determines what gets installed by default. If you set `version:` explicitly the action uses that and only the action.yml itself is taken from the tag ref.
