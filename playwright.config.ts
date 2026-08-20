import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // These contracts own isolated servers, provider/storage configuration, and
  // device names. Running them again under the generic matrix would exercise
  // a different environment rather than add coverage. Their dedicated package
  // scripts remain release gates.
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
  expect: {
    /*
     * Five seconds was never a decision — it is Playwright's default, chosen for
     * pages far lighter than this one, and it has been deciding outcomes.
     *
     * `profile-silo` waits for a transcript to become taller than its own
     * viewport before the journey it actually tests begins. On a workstation
     * that happens immediately; on a shared runner it exceeded 5s and the gate
     * reported `Expected: true, Received: false` — an assertion about layout
     * failing because of a clock. It failed all three attempts on one gate and
     * passed on retry on the other, from the same tree, which is the signature
     * of a budget rather than a defect. Six of that file's polls carry no
     * explicit timeout, and 19 of `conversation-navigation`'s 20 do not either.
     *
     * A longer budget weakens nothing: an assertion that would pass still passes
     * at the same speed, and only a genuinely failing one waits longer before
     * saying so. The alternative — sprinkling per-call timeouts wherever a flake
     * has been noticed — tunes the clock to whichever machine last complained.
     */
    timeout: 15_000,
  },
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
  webServer: [
    {
      // The complete matrix exercises the host-composed local lab. Provision
      // MinIO first with `npm run lab:storage`; this server owns only the exact
      // feature-flagged UI and carries no synthetic Google registration.
      command: "VITE_AIRSHIP_ENABLE_LOCAL_LAB=1 npm run dev",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // One acceptance case must observe a genuinely unconfigured build. A
      // lab-enabled bundle cannot prove absence of its own host-composed S3
      // option, so that case runs alone against a second exact build.
      command: "VITE_AIRSHIP_ENABLE_LOCAL_LAB=0 VITE_GOOGLE_CLIENT_ID= npx vite --host 127.0.0.1 --port 4174 --strictPort",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "desktop-chromium",
      grepInvert: /@unconfigured/u,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      grepInvert: /@unconfigured/u,
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
    {
      name: "unconfigured-desktop-chromium",
      grep: /@unconfigured/u,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:4174",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
