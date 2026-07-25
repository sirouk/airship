import { defineConfig, devices } from "@playwright/test";

export const SEMANTIC_ACCEPTANCE_ORIGIN = "http://127.0.0.1:4190";

/**
 * Opt-in, hardware-bearing semantic acceptance. The ordinary bundled
 * Chromium runner is deliberately allowed to have no GPU adapter; this gate
 * uses the installed stable Chrome channel so a real adapter can be observed
 * when the host exposes one. The test still fails closed to the WASM backend
 * when Chrome cannot activate WebGPU.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "live-semantic-embedding.spec.ts",
  outputDir: "test-results/live-semantic-acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: SEMANTIC_ACCEPTANCE_ORIGIN,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: "npm exec -- vite --host 127.0.0.1 --port 4190 --strictPort",
    url: SEMANTIC_ACCEPTANCE_ORIGIN,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{
    name: "desktop-chromium",
    use: {
      ...devices["Desktop Chrome"],
      channel: "chrome",
      viewport: { width: 1440, height: 1000 },
    },
  }],
});
