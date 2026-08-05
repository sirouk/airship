import { defineConfig, devices } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:4193";
const PUBLIC_BASE_PATH = "/airship/";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "live-static-host-isolation.spec.ts",
  outputDir: "test-results/static-host-isolation",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    baseURL: `${ORIGIN}${PUBLIC_BASE_PATH}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: `node scripts/headerless-static-server.mjs dist 4193 2000 ${PUBLIC_BASE_PATH}`,
    url: `${ORIGIN}${PUBLIC_BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
  projects: [{
    name: "desktop-chromium",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 1000 },
    },
  }],
});
