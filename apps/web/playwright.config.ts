import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8799);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    channel: process.env.PW_CHANNEL || undefined,
  },
  webServer: {
    command: "pnpm --filter @bulkhead/api start",
    url: `http://127.0.0.1:${port}/readyz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(port),
      BULKHEAD_PACE: "120",
      AIRWALLEX_MODE: "simulator",
      BULKHEAD_DATA_DIR: "./.e2e-data",
    },
    cwd: "../..",
  },
});
