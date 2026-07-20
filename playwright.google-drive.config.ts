import { defineConfig, devices } from "@playwright/test";

export const GOOGLE_DRIVE_TEST_CLIENT_ID = "123456789012-airship-browser-acceptance.apps.googleusercontent.com";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "google-drive-vault.spec.ts",
  outputDir: "test-results/google-drive",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4187",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `VITE_GOOGLE_CLIENT_ID=${GOOGLE_DRIVE_TEST_CLIENT_ID} npm run build:static && npx vite preview --host 127.0.0.1 --port 4187 --strictPort`,
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "google-drive-chromium", use: { browserName: "chromium" } }],
});
