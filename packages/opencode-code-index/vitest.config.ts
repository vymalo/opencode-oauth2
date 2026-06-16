import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The OpenCode entry wiring (opencode.ts/index.ts) is exercised e2e by the
      // host, not unit tests — exclude it from the metric like the browser MCP
      // bin is excluded.
      exclude: ["src/index.ts", "src/opencode.ts"],
      reporter: ["text-summary"],
      // Floors set a few points below current (98/85/97/99) so a regression
      // fails CI without exact-match churn.
      thresholds: { statements: 95, branches: 82, functions: 93, lines: 95 }
    }
  }
});
