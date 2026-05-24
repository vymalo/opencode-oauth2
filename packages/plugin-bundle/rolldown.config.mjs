// Rolldown bundling configuration for @lightbridge/opencode-plugin.
//
// Bundles the TypeScript entry from packages/opencode-plugin/src/index.ts into
// a single ESM artifact in packages/plugin-bundle/dist/index.mjs. The tsc build
// in opencode-plugin remains the development entry; this is the release artifact.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";
import builtins from "builtin-modules";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Externalize: every Node built-in (with and without the `node:` prefix), the
// opencode plugin host SDK, and the anticipated native addon package. Anything
// else is bundled into the artifact.
const nodeBuiltins = new Set([...builtinModules, ...builtins]);
const externalPackages = new Set(["@opencode-ai/plugin", "@lightbridge/native-core"]);

/**
 * @param {string} id
 * @returns {boolean}
 */
function isExternal(id) {
  if (id.startsWith("node:")) return true;
  if (nodeBuiltins.has(id)) return true;
  if (externalPackages.has(id)) return true;
  // Treat any subpath of an external package as external too.
  for (const pkg of externalPackages) {
    if (id === pkg || id.startsWith(`${pkg}/`)) return true;
  }
  return false;
}

/** @type {import('rolldown').RolldownOptions} */
const config = {
  input: resolve(__dirname, "../opencode-plugin/src/index.ts"),
  external: isExternal,
  platform: "node",
  output: {
    file: resolve(__dirname, "dist/index.mjs"),
    format: "esm",
    sourcemap: true,
    exports: "named",
    // Target Node 20+ — preserves modern syntax (top-level await, etc.).
    minify: false
  },
  resolve: {
    extensions: [".ts", ".mts", ".js", ".mjs", ".json"]
  },
  treeshake: true
};

export default config;
