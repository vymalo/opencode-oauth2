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
      reporter: ["text-summary"],
      // Floors a few points below current so a regression fails CI without
      // brittle exact-match churn. Tools are pure functions over DI'd clock /
      // random / fetch, so coverage stays high.
      thresholds: { statements: 88, branches: 80, functions: 85, lines: 88 }
    }
  }
});
