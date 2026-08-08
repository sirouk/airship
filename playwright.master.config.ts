import { defineConfig, devices } from "@playwright/test";

export const MASTER_ACCEPTANCE_ORIGIN = "http://127.0.0.1:4186";

export default defineConfig({
  testDir: "./e2e",
  // `developer-workflow-seam` is matched here because its git-in-the-terminal
  // case is gated on AIRSHIP_LIVE_WEBCONTAINER=1 and this config is the only
  // thing in the repository that sets it. A live gate in a file no live config
  // matches is not a strict test — it is a test that never runs, reported as a
  // skip forever, and it was carried through a rename in that state.
  testMatch: ["master-browser-acceptance.spec.ts", "live-webcontainer.spec.ts", "developer-workflow-seam.spec.ts"],
  outputDir: "test-results/master-browser-acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/master", open: "never" }]],
  // The specs written for this lane carry an explicit timeout on every
  // assertion that can be slow, so this budget never applied to them and 5s —
  // Playwright's default, which nobody here chose — was harmless. It stops
  // being harmless the moment a spec written under the general matrix joins:
  // `developer-workflow-seam` polls with plain `expect`, and it runs first in
  // this lane's alphabetical order, against a Vite dev server that compiles the
  // workbench on the first navigation. Matching playwright.config.ts's reasoned
  // 15s weakens nothing — an assertion that would pass still passes at the same
  // speed — and it keeps a release gate from being decided by a cold compile.
  expect: { timeout: 15_000 },
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
