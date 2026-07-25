import { defineConfig, devices } from "@playwright/test";

export const LIVE_ACCEPTANCE_ORIGIN = "http://127.0.0.1:4188";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "live-chutes-vision.spec.ts",
  outputDir: "test-results/live-chutes-acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: LIVE_ACCEPTANCE_ORIGIN,
    // The test enters a memory-only credential. Do not produce browser
    // recordings that could retain field contents on a failed run.
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    // Exercise the already-built release artifact rather than Vite's source
    // transformation path. `check:release:live` is a post-build gate.
    command: "npm exec -- vite preview --host 127.0.0.1 --port 4188 --strictPort",
    url: LIVE_ACCEPTANCE_ORIGIN,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{
    name: "desktop-chromium",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
  }],
});
