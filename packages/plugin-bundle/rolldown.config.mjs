// Phase 1 scaffold: bundling configuration will be implemented in later commits.
export default {
  input: "../opencode-plugin/src/index.ts",
  output: {
    file: "dist/plugin.js",
    format: "esm"
  },
  external: ["node:fs", "node:path", "@lightbridge/native-core"]
};
