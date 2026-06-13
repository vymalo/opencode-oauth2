import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// WXT builds a Chromium MV3 and a Firefox build from this single config.
// `debugger` and `tabGroups` are Chromium-only APIs — the CDP executor and
// named-group support degrade gracefully on Firefox (content-script executor +
// a logical group registry), so we drop those permissions from the Firefox
// manifest to avoid load-time warnings.
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  // Clean release-artifact names: opencode-browser-extension-<version>-<target>.zip
  zip: { name: "opencode-browser-extension" },
  // Explicit imports everywhere (no magic auto-imports) — clearer for readers
  // and avoids tsc surprises. `#imports` still resolves defineBackground/etc.
  imports: false,
  manifest: ({ browser }) => {
    const chromiumOnly = browser === "firefox" ? [] : ["debugger", "tabGroups"];
    return {
      name: "OpenCode Browser",
      description:
        "Lets an OpenCode agent drive this browser through the @vymalo/opencode-browser plugin's localhost bridge.",
      permissions: ["tabs", "scripting", "storage", "activeTab", "cookies", ...chromiumOnly],
      host_permissions: ["<all_urls>"]
    };
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
});
