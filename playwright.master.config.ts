import { defineConfig, devices } from "@playwright/test";

export const MASTER_ACCEPTANCE_ORIGIN = "http://127.0.0.1:4186";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "master-browser-acceptance.spec.ts",
  outputDir: "test-results/master-browser-acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/master", open: "never" }]],
  use: {
    baseURL: MASTER_ACCEPTANCE_ORIGIN,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "VITE_GOOGLE_CLIENT_ID=123456789012-airship-browser-acceptance.apps.googleusercontent.com npm exec -- vite --host 127.0.0.1 --port 4186 --strictPort",
    url: MASTER_ACCEPTANCE_ORIGIN,
    // Never accept an unrelated developer or stale acceptance server. A busy
    // port is a hard failure, and every run owns the exact process it tests.
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "tablet-chromium",
      use: { ...devices["iPad Pro 11"], browserName: "chromium" },
    },
    {
      name: "iphone-14-pro-max-chromium",
      use: { ...devices["iPhone 14 Pro Max"], browserName: "chromium" },
    },
  ],
});
