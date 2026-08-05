import { defineConfig, devices } from "@playwright/test";

export const PORTABILITY_ACCEPTANCE_ORIGIN = "http://127.0.0.1:4189";

/**
 * The portability matrix deliberately owns its server and browser contexts.
 * Stable Chrome is a hardware activation gate; the other projects prove that
 * the same client remains useful and honest when a primitive is absent.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "edge-portability.spec.ts",
  outputDir: "test-results/edge-portability",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/edge-portability", open: "never" }],
  ],
  use: {
    baseURL: PORTABILITY_ACCEPTANCE_ORIGIN,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "AIRSHIP_DISABLE_SEMANTIC_PACK=1 VITE_GOOGLE_CLIENT_ID=123456789012-airship-portability.apps.googleusercontent.com npm exec -- vite --host 127.0.0.1 --port 4189 --strictPort",
    url: PORTABILITY_ACCEPTANCE_ORIGIN,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chrome-stable-webgpu",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "firefox-desktop-fallback",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1366, height: 900 },
      },
    },
    {
      name: "webkit-iphone-14-pro-max",
      use: {
        ...devices["iPhone 14 Pro Max"],
        browserName: "webkit",
      },
    },
    {
      name: "chromium-tablet",
      use: {
        ...devices["iPad Pro 11"],
        browserName: "chromium",
      },
    },
    {
      name: "chromium-constrained-2c-2gib",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
        reducedMotion: "reduce",
      },
    },
  ],
});
