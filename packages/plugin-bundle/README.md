# @vymalo/opencode-oauth2-bundle

**Private** workspace package. Produces a single-file, dependency-bundled distribution of [`@vymalo/opencode-oauth2`](../opencode-oauth2) using [Rolldown](https://rolldown.rs).

This package is `private: true` — it is **not published to npm**. It exists to emit one self-contained ESM artifact (`dist/index.mjs`) for environments that prefer to vendor the plugin as a single file rather than install it from the registry.

## What it does

[`rolldown.config.mjs`](rolldown.config.mjs) bundles the plugin's TypeScript entry (`../opencode-oauth2/src/index.ts`) into `dist/index.mjs`:

- **Externalized:** every Node built-in (with and without the `node:` prefix) and the plugin host SDK `@opencode-ai/plugin`. These are provided by the OpenCode runtime, so they stay as bare imports.
- **Bundled:** everything else is tree-shaken and inlined into the single artifact.
- **Output:** ESM, named exports, sourcemap, unminified (targets Node 20+, preserving modern syntax like top-level `await`).

The `tsc` build inside `opencode-oauth2` remains the development entry point; this bundle is the release-style artifact.

> Only `opencode-oauth2` is bundled today. `@vymalo/opencode-models-info` and `@vymalo/opencode-ratelimit` are consumed directly from npm and have no bundle target.

## Commands

```sh
pnpm --filter @vymalo/opencode-oauth2-bundle build   # rolldown → dist/index.mjs
pnpm --filter @vymalo/opencode-oauth2-bundle clean    # rm -rf dist
```

`build` runs [`scripts/build.mjs`](scripts/build.mjs), which drives Rolldown with the config above. Run the oauth2 package's build/test first if you've changed its source.

## Versioning

Kept on the **same version line** as the rest of the workspace (currently `0.5.0`) and bumped together in the release PR, even though it isn't published. It depends on `@vymalo/opencode-oauth2` via `workspace:*`, so a version bump touches only `version` fields — no lockfile change. See the root [CLAUDE.md](../../CLAUDE.md) "Releasing" section.

## License

MIT
