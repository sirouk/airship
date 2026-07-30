import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The OAuth journey ends in a connection, not in another button.
 *
 * Signing in to Chutes is a full authorization round trip: the person asked to
 * connect, authorized at the IdP, and came back. Everything after that is
 * verification, not choice — yet the credential was first exercised only by
 * `activate()`, which was reachable exclusively from a "Finish: verify &
 * connect" press, and the model it would have used was already pre-selected
 * with the default proof policy. Worse, `AccessView` is conditionally mounted
 * and the credential handoff was a single-use ref, so navigating away from
 * #connection before that press discarded an exchange the user had already
 * paid for and returned an empty entry stack.
 *
 * Both halves are asserted here, because both are only observable as a browser
 * journey: zero presses from redirect to a live connection, and a remount that
 * re-enters discovery from the still-valid token instead of forgetting it.
 *
 * The boundaries are stubbed at the network, never inside the app: the token
 * handler, the IdP, the two catalog reads and the E2EE instance lease are all
 * fulfilled as HTTP, so the code under test is the shipped discovery,
 * verification and commit path.
 */
const CHUTE_ID = "8f2b7e1a-0000-4c1d-9a11-oauthjourney01";
const MODEL_ID = "airship-acceptance/confidential-oauth-8b";

function chutesModelsPayload(): unknown {
  return {
    data: [{
      id: MODEL_ID,
      chute_id: CHUTE_ID,
      root: MODEL_ID,
      owned_by: "vllm",
      created: 1_780_000_000,
      context_length: 32_768,
      max_model_len: 32_768,
      max_output_length: 4_096,
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_features: ["tools", "json_mode"],
      supported_sampling_parameters: ["temperature", "top_p"],
      // The whole reason this model is eligible: discovery must say
      // confidential_compute and management must agree, or the merged trust
      // state is `partial`/`conflict` and the model is not an E2EE candidate.
      confidential_compute: true,
      pricing: { per_million_tokens: { input: 0.2, output: 0.6 } },
    }],
  };
}

function chutesManagementPayload(): unknown {
  return {
    total: 1,
    items: [{
      chute_id: CHUTE_ID,
      name: "Confidential OAuth 8B",
      slug: "confidential-oauth-8b",
      tagline: "Acceptance fixture",
      public: true,
      tee: true,
      hot: true,
      invocation_count: 4_096,
      pricing: { per_million_tokens: { input: 0.2, output: 0.6 } },
    }],
  };
}

async function stubChutesBoundaries(page: Page): Promise<{ verifications: () => number }> {
  let verifications = 0;
  await page.route("http://localhost:4173/__airship/chutes/oauth/token", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "cak_oauth-autoconnect.access",
        refresh_token: "crt_oauth-autoconnect.refresh",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "openid profile chutes:invoke billing:read",
      }),
    });
  });
  await page.route("https://llm.chutes.ai/**", async (route) => {
    await json(route, chutesModelsPayload());
  });
  await page.route("https://api.chutes.ai/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/idp/authorize") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Chutes authorization boundary reached</title>",
      });
      return;
    }
    if (pathname === "/chutes/") {
      await json(route, chutesManagementPayload());
      return;
    }
    if (pathname === "/chutes/utilization") {
      await json(route, []);
      return;
    }
    if (pathname === `/e2e/instances/${CHUTE_ID}`) {
      // This lease fetch *is* `verifyModelAccess`. Counting it is how the test
      // proves the credential was actually exercised rather than the connection
      // being taken on the catalog's word.
      verifications += 1;
      await json(route, {
        nonce_expires_in: 55,
        instances: [{
          instance_id: "instance-oauth-autoconnect",
          e2e_pubkey: "TFmT8HLCwXR8B3PPvZ2m4gCSt2mzZ0zTUJ5uNv8Fpxo=",
          nonces: ["nonce-oauth-autoconnect-0", "nonce-oauth-autoconnect-1"],
        }],
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  return { verifications: () => verifications };
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function openConnect(page: Page): Promise<void> {
  await page.goto("http://localhost:4173/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  // The bridge lanes start "checking" and settle on a real handshake deadline;
  // the route header's ⓘ auto-opens on first visit and overlays the lead lane
  // until dismissed, so both are waited out before anything below is clicked.
  await expect(page.locator('.connect-lane[data-lane="claude"]'))
    .not.toHaveAttribute("data-state", "checking", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".route-header__about")).toHaveAttribute("data-open", "false");
  const chutes = page.locator('.connect-lane[data-lane="chutes"]');
  await expect(chutes).toHaveCount(1);
  if ((await chutes.getAttribute("data-open")) !== "true") {
    await chutes.locator("button.connect-lane__header").click();
  }
  await expect(chutes).toHaveAttribute("data-open", "true");
}

/** Drives the redirect leg and returns on the callback's own load. */
async function completeAuthorization(page: Page): Promise<void> {
  await openConnect(page);
  await page.locator('.connect-lane[data-lane="chutes"]').getByRole("button", { name: "Sign in to Chutes" }).click();
  await expect(page).toHaveURL(/^https:\/\/api\.chutes\.ai\/idp\/authorize\?/u);
  const state = new URL(page.url()).searchParams.get("state");
  expect(state).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
  await page.goto(
    `http://localhost:4173/auth/chutes/callback?code=one-time-code&state=${encodeURIComponent(state!)}`,
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

test("a returning Chutes redirect connects and opens Chat with no further press", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authorization round trip is enough to pin this contract");
  test.setTimeout(90_000);
  const boundaries = await stubChutesBoundaries(page);

  await completeAuthorization(page);

  /*
   * The acceptance, verbatim: zero presses after the redirect returns. If any
   * press were still required the journey would rest on #connection with the
   * Finish button, so asserting the Chat URL *and* the absence of that button
   * is what distinguishes "connected automatically" from "connected quickly".
   */
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Finish: verify & connect/u })).toHaveCount(0);
  // The demo chip is the disconnected state's model chip; a live connection
  // replaces it with the model control naming what is actually answering.
  await expect(page.locator(".session-model-chip--demo")).toHaveCount(0);
  expect(boundaries.verifications(), "the credential was exercised, not assumed").toBeGreaterThanOrEqual(1);

  /*
   * Back to Connection through the hash, never `page.goto`: the connection this
   * test is about lives in page memory, so a reload would destroy the very
   * thing being asserted. The lane's own state word is the anchor — the Chutes
   * lane must now describe a connection rather than offer the entry stack.
   */
  await page.evaluate(() => { window.location.hash = "#connection"; });
  await expect(page.locator('.connect-lane[data-lane="chutes"]'))
    .toHaveAttribute("data-state", "connected", { timeout: 30_000 });
});

test("leaving #connection after the callback does not discard the exchange", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authorization round trip is enough to pin this contract");
  test.setTimeout(90_000);
  /*
   * Same round trip, but the catalog refuses. Discovery therefore cannot
   * complete and no connection is committed, which is exactly the state in
   * which the credential handoff used to be destroyed: `takePendingOAuthCredential`
   * consumed the ref, AccessView is conditionally mounted, and its `candidate`
   * is component state, so one navigation away turned a completed authorization
   * into a full re-authorization.
   */
  let catalogAvailable = false;
  await page.route("http://localhost:4173/__airship/chutes/oauth/token", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "cak_oauth-remount.access",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "openid profile chutes:invoke billing:read",
      }),
    });
  });
  await page.route("https://llm.chutes.ai/**", async (route) => {
    if (!catalogAvailable) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "catalog unavailable" }) });
      return;
    }
    await json(route, chutesModelsPayload());
  });
  await page.route("https://api.chutes.ai/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/idp/authorize") {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Chutes authorization boundary reached</title>" });
      return;
    }
    if (pathname === "/chutes/") {
      if (!catalogAvailable) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "catalog unavailable" }) });
        return;
      }
      await json(route, chutesManagementPayload());
      return;
    }
    if (pathname === "/chutes/utilization") {
      await json(route, []);
      return;
    }
    if (pathname === `/e2e/instances/${CHUTE_ID}`) {
      await json(route, {
        nonce_expires_in: 55,
        instances: [{
          instance_id: "instance-oauth-remount",
          e2e_pubkey: "TFmT8HLCwXR8B3PPvZ2m4gCSt2mzZ0zTUJ5uNv8Fpxo=",
          nonces: ["nonce-oauth-remount-0"],
        }],
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await completeAuthorization(page);
  // Discovery reports above the lanes, not inside one: the refusal answers the
  // button that was just pressed and used to render 340px past it.
  await expect(page.locator(".access-live-error")).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/#chat/u);

  // Leave the route, which unmounts AccessView and revokes the ephemeral
  // transport, then come back. The token is still live, so discovery re-runs.
  await page.evaluate(() => { window.location.hash = "#workspace"; });
  await expect(page.locator(".connect-surface")).toHaveCount(0);
  catalogAvailable = true;
  await page.evaluate(() => { window.location.hash = "#connection"; });

  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });
  await expect(page.locator(".session-model-chip--demo")).toHaveCount(0);
});
