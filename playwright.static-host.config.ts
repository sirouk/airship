import { defineConfig, devices } from "@playwright/test";

export const ORIGIN = "http://127.0.0.1:4193";

/**
 * The path the artifact under test was compiled against.
 *
 * The Pages workflow derives it from the repository name, so a fork published
 * at `/<repo>/` must be proved at `/<repo>/`; a gate pinned to `/airship/`
 * would serve that build at a path none of its URLs name and fail for a reason
 * that has nothing to do with the boundary it exists to check. The default is
 * the value this repository publishes at, so a bare local run is unchanged.
 */
export const PUBLIC_BASE_PATH = normalizedBasePath(process.env.AIRSHIP_PUBLIC_BASE_PATH);

function normalizedBasePath(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate || candidate === "/") return candidate === "/" ? "/" : "/airship/";
  if (!candidate.startsWith("/")) throw new Error("AIRSHIP_PUBLIC_BASE_PATH must be an absolute URL path.");
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "live-static-host-isolation.spec.ts",
  outputDir: "test-results/static-host-isolation",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    baseURL: `${ORIGIN}${PUBLIC_BASE_PATH}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: `node scripts/headerless-static-server.mjs dist 4193 2000 ${PUBLIC_BASE_PATH}`,
    url: `${ORIGIN}${PUBLIC_BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
  projects: [{
    name: "desktop-chromium",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 1000 },
    },
  }],
});
