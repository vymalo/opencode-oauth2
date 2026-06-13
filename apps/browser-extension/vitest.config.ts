import { defineConfig } from "vitest/config";

// Only pure, browser-API-free helpers are unit-tested here (executor selection,
// snapshot ref formatting, group slugging). Entrypoints that touch chrome.* are
// exercised manually against a real browser — see docs/browser.md.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true
  }
});
