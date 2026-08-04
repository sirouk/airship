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
  webServer: {
    // The main matrix deliberately carries no client ID: `vault-provider-switch`
    // asserts that a provider that cannot be opened cannot be chosen (the
    // "unavailable here" selectability contract), which is only testable where
    // the Google surface has no registration. Every dedicated config that does
    // exercise a Google flow (master, google-drive, portability) sets its own
    // synthetic registration in its own env, on its own port.
    //
    // `npm run check:browser` runs the two geometry specs through this same
    // config, so a local `npm run check` will adopt whatever is already on 4173
    // rather than cold-booting a second Vite. That is deliberate and safe for
    // those two specifically: they assert overflow and touch-target geometry,
    // which no provider registration can make true or false. It is *not* safe
    // in general — a lab-owned Vite always sets `VITE_GOOGLE_CLIENT_ID`, which
    // is exactly how `vault-provider-switch` came to fail on a premise the
    // harness had broken — so the check runs a named pair of files, never the
    // whole suite.
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
