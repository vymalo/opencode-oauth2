import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", "dist/**"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // Floors a few points below current so a regression fails CI without
      // brittle exact-match churn. The plugin is DI-structured and well-tested.
      thresholds: { statements: 88, branches: 74, functions: 82, lines: 88 }
    }
  }
});
