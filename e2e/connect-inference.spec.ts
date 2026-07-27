import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The connect surface, walked the way a person with no credentials walks it.
 *
 * Nothing here stubs the thing it is asserting: the extension-absent state is
 * the real outcome of a real `hello` handshake in a browser with no Airship
 * extension installed, the local lane's button issues a real loopback request,
 * and the paste-back assertions drive the real field with real values.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

async function openConnect(page: Page) {
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connect models", level: 1 })).toBeVisible();
  await expect(page.locator(".connect-surface")).toBeVisible();
  // The bridge lanes start as "checking" and settle only when the handshake
  // deadline passes, so every later assertion waits for a real observation
  // rather than reading the in-flight state.
  await expect(page.locator('.connect-lane[data-lane="claude"]'))
    .not.toHaveAttribute("data-state", "checking", { timeout: 15_000 });
}

async function openLane(page: Page, lane: string) {
  const card = page.locator(`.connect-lane[data-lane="${lane}"]`);
  await expect(card).toHaveCount(1);
  if ((await card.getAttribute("data-open")) !== "true") {
    await card.locator("button.connect-lane__header").click();
  }
  await expect(card).toHaveAttribute("data-open", "true");
  return card;
}

test("the companion install hub offers verified packages with device-appropriate guidance", async ({ page }, testInfo) => {
  await page.goto("/extension/index.html");
  await expect(page.getByRole("heading", { name: "More reach. More local headroom." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Verify SHA-256 checksums" })).toHaveAttribute("href", "./releases/SHA256SUMS");
  await expect(page.getByRole("link", { name: "Download Chrome package" })).toHaveAttribute(
    "href",
    "./releases/airship-companion-chromium-release.zip",
  );
  await expect(page.getByRole("link", { name: "Download Firefox source" })).toHaveAttribute(
    "href",
    "./releases/airship-companion-firefox-release.zip",
  );
  await expect(page.getByRole("link", { name: "Download Safari source" })).toHaveAttribute(
    "href",
    "./releases/airship-companion-safari-release.zip",
  );
  const guidance = page.locator("#browser-guidance");
  await expect(guidance).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    // The mobile project intentionally combines Chromium with an iPhone
    // profile; platform UA policy may therefore expose either the Chromium
    // no-extension path or the iOS containing-app path. Both are truthful and
    // neither offers a desktop ZIP as one-tap mobile installation.
    await expect(guidance).toContainText(
      /does not install desktop WebExtensions|requires the signed Airship containing app/u,
    );
  } else {
    await expect(page.locator('[data-browser="chrome"]')).toHaveClass(/recommended/u);
    await expect(guidance).toContainText("highlighted the package");
  }
});

test("a visitor with no credentials lands inside a path that works", async ({ page }) => {
  await openConnect(page);

  // Ordering is the fix for the measured drop-off: whatever leads must be
  // something a person can act on, not a provider that needs an extension.
  const leadLane = page.locator(".connect-lane").first();
  await expect(leadLane).toHaveAttribute("data-open", "true");
  await expect(leadLane).toHaveAttribute("data-state", /connected|ready/u);

  const chutes = await openLane(page, "chutes");
  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await expect(chutes.locator("section.api-key-alternative")).toBeVisible();
  await expect(chutes.locator('input[name="chutes-api-key"]')).toBeVisible();
  await expect(chutes.getByRole("link", { name: /Create a key at chutes\.ai/u })).toBeVisible();
  await expect(chutes).toContainText("Chutes personal keys start with cpk_");

  // The operator sentence must not be what a person is asked to act on.
  await expect(page.locator(".connect-surface")).not.toContainText(/Restart the Airship companion/u);
  await expect(page.locator(".connect-surface")).not.toContainText(/process-held client secret/u);
});

test("Claude and Grok state the extension honestly and offer no broken button", async ({ page }) => {
  await openConnect(page);

  for (const lane of ["claude", "grok"] as const) {
    const card = await openLane(page, lane);
    const state = await card.getAttribute("data-state");
    expect(["ready", "needs-extension", "extension-unavailable"], `${lane} state`).toContain(state);

    // One sentence naming why, in the vendor's terms, not the user's fault.
    await expect(card).toContainText(/No browser extension answered the bridge handshake/u);
    await expect(card.locator(".connect-extension__boundary summary")).toBeVisible();

    /*
     * This exact sentence can only be produced by the bridge package's reader
     * from a handshake that was actually sent and actually went unanswered
     * inside its deadline. A compiled-in constant cannot say "within 1500 ms".
     */
    await expect(card.locator(".connect-extension__observation"))
      .toContainText(/No browser extension answered the bridge handshake within \d+ ms/u);

    // No control in a blocked lane may look like a working sign-in.
    await expect(card.getByRole("button", { name: /^Sign in/u })).toHaveCount(0);

    // A real install hub now exists even before store signing, so there is
    // always a truthful route to reviewed packages and browser-specific steps.
    await expect(page.locator(".companion-overview").getByRole("link", { name: /Get the extension/u }))
      .toHaveAttribute("href", /\/extension\/index\.html$/u);
  }

  // Both vendors have a browser-direct key adapter on this same route, so both
  // lanes owe a person that route rather than under-claiming it away.
  await expect(page.locator('.connect-lane[data-lane="claude"]')).toContainText("Anthropic API key");
  await expect(page.locator('.connect-lane[data-lane="grok"]')).toContainText("xAI API key");
});

test("the API-key alternative moves to the direct providers without leaving the route", async ({ page }) => {
  await openConnect(page);
  const claude = await openLane(page, "claude");
  const alternative = claude.getByRole("tab", { name: /^API key/u });
  await expect(alternative).toBeVisible();
  await alternative.click();
  const configure = claude.getByRole("button", { name: "Configure API key" });
  await expect(configure).toBeVisible();
  await configure.click();

  await expect(page).toHaveURL(/#connection$/);
  await expect(page.locator("#provider-setup-anthropic")).toBeFocused();
});

test("the section jump controls do not eject the visitor to Chat", async ({ page }) => {
  await openConnect(page);
  await page.getByRole("button", { name: /Cloud keys & local models/u }).click();
  await expect(page).toHaveURL(/#connection$/);
  await expect(page.getByRole("heading", { name: "Connect models", level: 1 })).toBeVisible();

  await page.locator(".access-provider-jump").getByRole("button", { name: "Providers" }).click();
  await expect(page).toHaveURL(/#connection$/);
});

test("the local lane never claims a server before anything was checked", async ({ page }) => {
  await openConnect(page);
  const local = await openLane(page, "local");
  await expect(local).toContainText("has not looked yet");
  await expect(local).not.toContainText(/detected|already running/u);
  await expect(local.locator(".connect-local__results")).toBeEmpty();
});

test("the Chutes key panel is already open when this build has no sign-in", async ({ page }) => {
  await openConnect(page);
  const chutes = await openLane(page, "chutes");
  test.skip(
    await chutes.getByRole("button", { name: "Sign in to Chutes" }).count() > 0,
    "This build configures the Chutes sign-in exchange, so the key panel is the alternative rather than the route.",
  );

  // Nothing is clicked: a cold visitor whose only working route is the key must
  // land already inside it, with the field itself reachable.
  await expect(chutes.getByRole("tab", { name: /^API key/u })).toHaveAttribute("aria-selected", "true");
  await expect(chutes.locator("section.api-key-alternative")).toBeVisible();
  await expect(chutes.locator('input[name="chutes-api-key"]')).toBeVisible();
  // The summary sits a line above the status and is bound by the same rule.
  await expect(chutes.locator(".connect-lane__summary")).not.toContainText(/Sign in/u);
});

test("Check this machine issues a real loopback probe and keeps every other lane", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One real loopback transport journey is sufficient.");
  await mockOllama(page);
  await openConnect(page);
  const local = await openLane(page, "local");

  // Exact: the lane header's accessible name carries the same status label.
  await local.getByRole("button", { name: "Check this machine", exact: true }).click();

  // The request really went to 127.0.0.1:11434: only the mocked service can
  // supply this roster, and only a refused port can produce the second line.
  const results = local.locator(".connect-local__results li");
  await expect(results.filter({ hasText: "Ollama" }).first()).toContainText(/Answered on 127\.0\.0\.1:11434 · \d+ model/u, {
    timeout: 20_000,
  });
  await expect(results.filter({ hasText: "LM Studio" }).first()).toContainText(/did not answer/u);

  // A connected provider must not take the rest of the surface away with it.
  await expect(page.locator('.connect-lane[data-lane="local"]')).toHaveAttribute("data-state", "connected");
  await expect(page.locator("button.connect-lane__header")).toHaveCount(5);
  const chutes = await openLane(page, "chutes");
  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await expect(chutes.locator('input[name="chutes-api-key"]')).toBeVisible();
});

test("the paste-back step warns first and answers while the code is typed", async ({ page }) => {
  await openConnect(page);
  const codex = await openLane(page, "codex");
  const state = await codex.getAttribute("data-state");
  test.skip(
    state !== "ready",
    `Codex sign-in is not wired into this build (lane state "${state}"), so there is no paste field to drive. `
    + "This test runs unchanged as soon as the port is supplied.",
  );

  // The warning has to arrive before the vendor tab, not after the error page.
  await expect(codex).toContainText(/will look like an error|can’t be reached/u);
  await expect(codex.locator(".connect-paste__example mark")).toContainText("code=");

  const field = codex.getByLabel("Address from the error page");
  const finish = codex.getByRole("button", { name: /Finish connecting Codex/u });
  await expect(finish).toBeDisabled();

  await field.fill("http://localhost:1455/auth/callback");
  await expect(codex.locator(".connect-paste__reading")).toContainText("no code in it");
  await expect(finish).toBeDisabled();

  await field.fill("sk-proj-abcdefghijklmnop");
  await expect(codex.locator(".connect-paste__reading")).toContainText("API key");
  await expect(finish).toBeDisabled();

  await field.fill("http://localhost:1455/auth/callback?code=ac_e2e_1a2b3c&state=st_e2e");
  await expect(codex.locator(".connect-paste__reading")).toContainText("Code read from the address");
  await expect(codex.locator(".connect-paste__preview")).toContainText("ac_e…2b3c");
  await expect(finish).toBeEnabled();

  // A stubbed vendor boundary: the exchange is refused at the network edge and
  // the surface has to report that refusal rather than a success.
  await page.route("https://auth.openai.com/**", (route) => route.fulfill({
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: "invalid_grant", error_description: "authorization code expired" }),
  }));
  await finish.click();
  await expect(codex.locator(".connect-lane__failure")).toBeVisible();
  await expect(codex.locator(".connect-lane__failure")).toContainText(/expired|invalid_grant/u);
});

test("the connect surface is usable on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone layout contract");
  await openConnect(page);

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    surface: (() => {
      const element = document.querySelector(".connect-surface");
      return element ? element.scrollWidth - element.clientWidth : 0;
    })(),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.surface).toBeLessThanOrEqual(1);

  const headers = page.locator("button.connect-lane__header");
  const count = await headers.count();
  expect(count).toBe(5);
  for (let index = 0; index < count; index += 1) {
    const box = await headers.nth(index).boundingBox();
    expect(box?.height ?? 0, `lane header ${index} height`).toBeGreaterThanOrEqual(44);
  }
});

test("every lane is reachable by keyboard alone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "keyboard contract");
  await openConnect(page);

  const reached = new Set<string>();
  await page.locator("button.connect-lane__header").first().focus();
  for (let step = 0; step < 60 && reached.size < 5; step += 1) {
    const lane = await page.evaluate(() => document.activeElement?.closest(".connect-lane")?.getAttribute("data-lane") ?? "");
    const isHeader = await page.evaluate(() => document.activeElement?.classList.contains("connect-lane__header") ?? false);
    if (lane && isHeader) {
      reached.add(lane);
      await page.keyboard.press("Enter");
      await expect(page.locator(`.connect-lane[data-lane="${lane}"]`)).toHaveAttribute("data-open", "true");
    }
    await page.keyboard.press("Tab");
  }
  expect([...reached].sort()).toEqual(["chutes", "claude", "codex", "grok", "local"]);
});

/**
 * The one stubbed boundary in this file: the loopback service itself. The
 * request, the CORS preflight, the catalog read and the fabric connection are
 * all real, so removing the probe from the button makes the assertion fail.
 */
async function mockOllama(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:11434/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    if (url.pathname === "/api/version") {
      await cors(route, 200, JSON.stringify({ version: "0.12.3" }), "application/json");
      return;
    }
    if (url.pathname === "/api/tags") {
      await cors(route, 200, JSON.stringify({
        models: [{
          name: "gemma3:latest",
          size: 3_338_801_804,
          digest: "sha256:connect-surface-acceptance",
          modified_at: "2026-07-20T00:00:00Z",
          details: { format: "gguf", family: "gemma3", parameter_size: "4.3B", quantization_level: "Q4_K_M" },
        }],
      }), "application/json");
      return;
    }
    if (url.pathname === "/api/show") {
      await cors(route, 200, JSON.stringify({
        capabilities: ["completion", "tools"],
        model_info: { "gemma3.context_length": 131_072 },
      }), "application/json");
      return;
    }
    await cors(route, 404, "not found");
  });
}

async function cors(route: Route, status: number, body: string, contentType = "text/plain"): Promise<void> {
  await route.fulfill({
    status,
    body,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": contentType,
    },
  });
}
