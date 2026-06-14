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
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // TODO(phase-2): raise once chrome/DOM glue is testable via a fake-browser harness.
      thresholds: { statements: 3, branches: 3, functions: 2, lines: 3 }
    }
  }
});
