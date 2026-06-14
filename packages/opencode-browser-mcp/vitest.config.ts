import { defineConfig } from "vitest/config";

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
      // mcp.ts is the stdio process entry (main(): env parse, StdioServerTransport,
      // signal handlers) — exercised manually/e2e, not unit-testable. index.ts is a
      // pure re-export. Threshold applies to the real logic (server.ts + render.ts).
      exclude: ["src/mcp.ts", "src/index.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 95, branches: 65, functions: 95, lines: 95 }
    }
  }
});
