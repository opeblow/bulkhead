import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/api/src/**"],
      exclude: [
        "apps/api/src/main.ts",
        "apps/api/src/demo-cli.ts",
        "apps/api/src/sandbox-smoke.ts",
        "**/index.ts",
      ],
      reporter: ["text", "lcov", "html"],
    },
  },
});
