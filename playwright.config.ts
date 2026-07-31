import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // These contracts own isolated servers, provider configuration, device
  // names, and (for Chutes) credential-recording policy. Running them again
  // under the generic matrix would exercise a different environment rather
  // than add coverage. Their dedicated package scripts remain release gates.
  testIgnore: [
    "google-drive-vault.spec.ts",
    "master-browser-acceptance.spec.ts",
    "edge-portability.spec.ts",
    "live-*.spec.ts",
  ],
  outputDir: "test-results",
  // The browser suite deliberately exercises one authoritative MinIO
  // namespace. Serial projects make cross-browser durability checks
  // deterministic and avoid turning the dev server's HMR reconnect worker
  // into product noise under artificial parallel saturation.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // The main matrix deliberately carries no client ID: `vault-provider-switch`
    // asserts that a provider that cannot be opened cannot be chosen (the
    // "unavailable here" selectability contract), which is only testable where
    // the Google surface has no registration. Every dedicated config that does
    // exercise a Google flow (master, google-drive, portability) sets its own
    // synthetic registration in its own env, on its own port.
    command: "npm run dev",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
