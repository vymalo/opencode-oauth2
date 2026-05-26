// OpenCode plugin entry. The host iterates every named export of this module
// and rejects any export that isn't a Plugin function (or { server: Plugin }).
// Only the plugin function lives here; the library API is in ./lib.ts and is
// exposed via the "./lib" subpath in package.json.
export { default } from "./opencode.js";
