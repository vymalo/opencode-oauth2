import { defineConfig } from "vitest/config";

// Only pure, browser-API-free helpers are unit-tested here (executor selection,
// snapshot ref formatting, group slugging, annotation coordinate math). Most of
// the extension is chrome.*/DOM/React glue, exercised manually against a real
// browser — see docs/browser.md. The coverage floor below is intentionally low;
// it's raised once the fake-browser (jsdom + fake chrome) harness lands and lets
// the background command-router / feedback orchestration be unit-tested.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/helpers/setup.ts"],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // Raised in phase 2 once a fake-chrome harness made the background logic
      // (feedback orchestration, side-panel store, command router) testable.
      // Still climbing — bridge-client, group-registry, page-actions (jsdom) and
      // the React panels remain follow-ups.
      thresholds: { statements: 13, branches: 9, functions: 11, lines: 13 }
    }
  }
});
