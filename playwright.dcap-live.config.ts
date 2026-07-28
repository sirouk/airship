import { defineConfig, devices } from "@playwright/test";

export const DCAP_LIVE_ACCEPTANCE_ORIGIN = "http://127.0.0.1:4191";

/**
 * Opt-in browser proof over captured Chutes evidence and live Intel collateral.
 * This must use Vite's source server because the probe imports the reviewed
 * verifier port directly inside the page rather than navigating product UI.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "live-dcap-qvl.spec.ts",
  outputDir: "test-results/live-dcap-qvl",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  use: {
    baseURL: DCAP_LIVE_ACCEPTANCE_ORIGIN,
    // The page-evaluation payload contains captured provider evidence. Keep it
    // out of browser recordings even though it is not an account credential.
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "npm exec -- vite --host 127.0.0.1 --port 4191 --strictPort",
    url: DCAP_LIVE_ACCEPTANCE_ORIGIN,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{
    name: "dcap-live-chromium",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
  }],
});
