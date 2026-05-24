#!/usr/bin/env node
// Build entry point for @lightbridge/plugin-bundle.
//
// Loads the Rolldown config and writes the bundled ESM artifact + sourcemap to
// packages/plugin-bundle/dist/. Targets Node 20+.
import { rolldown } from "rolldown";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

import config from "../rolldown.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function main() {
  const started = performance.now();

  const { input, external, platform, resolve: resolveOpts, treeshake, output } = config;

  const bundle = await rolldown({
    input,
    external,
    platform,
    resolve: resolveOpts,
    treeshake
  });

  try {
    await bundle.write(output);
  } finally {
    await bundle.close();
  }

  const elapsedMs = (performance.now() - started).toFixed(1);
  const rel = relative(repoRoot, output.file);
  console.log(`plugin-bundle: wrote ${rel} (${elapsedMs} ms)`);
}

main().catch((err) => {
  console.error("plugin-bundle build failed:", err);
  process.exitCode = 1;
});
