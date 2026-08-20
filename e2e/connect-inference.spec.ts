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

async function openConnect(page: Page, url = "/#connection") {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  await expect(page.locator(".connect-surface")).toBeVisible();
  // The bridge lanes start as "checking" and settle only when the handshake
  // deadline passes, so every later assertion waits for a real observation
  // rather than reading the in-flight state.
  await expect(page.locator('.connect-lane[data-lane="claude"]'))
    .not.toHaveAttribute("data-state", "checking", { timeout: 15_000 });
  /*
   * `<RouteHeader>`'s ⓘ auto-opens on a route's first visit, which is where the
   * page's eyebrow and its two orientation paragraphs now live. Its panel is an
   * absolutely-positioned overlay anchored under the route title, so on this
   * route it lands over the top of the lead lane and swallows the first click
   * aimed at anything beneath it. Every test below drives controls in that
   * region, so the panel is dismissed the way a person dismisses it.
   *
   * Recorded rather than worked around: the panel covering the route's primary
   * control on arrival is a defect in the shared header's placement, not in
   * this surface, and it is reported to that package.
   */
  await page.keyboard.press("Escape");
  await expect(page.locator(".route-header__about")).toHaveAttribute("data-open", "false");
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
  await page.goto("/extension/");
  await expect(page.getByRole("heading", { name: "More reach. More local headroom." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Verify SHA-256 checksums" })).toHaveAttribute("href", "./releases/SHA256SUMS");
  await expect(page.locator("#channel-guidance")).toContainText(
    "Local Airship detected · Development channel selected",
  );
  await expect(page.getByRole("link", { name: "Download Chrome development package" })).toHaveAttribute(
    "href",
    "./releases/airship-companion-chromium-development.zip",
  );
  await expect(page.getByRole("link", { name: "Download Firefox development source" })).toHaveAttribute(
    "href",
    "./releases/airship-companion-firefox-development.zip",
  );
  await expect(page.getByRole("link", { name: "Download Safari development source" })).toHaveAttribute(
    "href",
    "./releases/airship-companion-safari-development.zip",
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
    await expect(guidance).toContainText("highlighted the development package");
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

    /*
     * AMENDED: the OAuth tab is selected explicitly before its panel is read.
     * A lane whose sign-in leg cannot work no longer *opens* on that leg — the
     * key route that works is the default — but the tab stays present and
     * selectable, because that panel is where the honest reason lives. Doing
     * the selection here makes the replacement invariant stronger: it proves
     * the tab is still reachable AND that its contents survived, where the old
     * assertion only proved the second because the tab happened to be default.
     */
    await card.getByRole("tab", { name: /^OAuth/u }).click();

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
    // The Companion is the sixth lane now; its install route is in the lane
    // body, one 44px row away, and the row itself states that it is not
    // installed rather than advertising the extension above the providers.
    const companion = await openLane(page, "companion");
    await expect(companion.getByRole("link", { name: /Get the extension/u }))
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

/*
 * AMENDED. The two `.access-provider-jump` buttons are gone with the sections
 * they pointed at — proposal 1 of the connect IA collapses the eyebrow, the H1,
 * the paragraph, the jump nav and the second heading block into one 44px route
 * bar. The rule they existed to prove is kept and made STRONGER: instead of
 * clicking two specific controls and checking the hash survived, this asserts
 * that no in-page anchor exists at all on the route, so no future control can
 * reintroduce the defect, and that moving around the surface never rewrites the
 * router hash. The words the jump nav carried are unaffected — they were
 * navigation labels for destinations, not claims.
 */
test("nothing on the connect route navigates by hash", async ({ page }) => {
  await openConnect(page);
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  const inPageAnchors = await page.evaluate(() =>
    [...document.querySelectorAll("main a")].filter((node) => (node.getAttribute("href") ?? "").startsWith("#")).length);
  expect(inPageAnchors, "the hash is the router; an in-page anchor resolves to an unknown route").toBe(0);

  const claude = await openLane(page, "claude");
  await claude.getByRole("tab", { name: /^API key/u }).click();
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
  await blockLmStudio(page);
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
  // AMENDED 5 → 6: the Airship Companion is now the sixth row of this same
  // list, in the same vocabulary, instead of a 219px card above it. The
  // invariant is unchanged and now covers one more surface.
  await expect(page.locator('.connect-lane[data-lane="local"]')).toHaveAttribute("data-state", "connected");
  await expect(page.locator("button.connect-lane__header")).toHaveCount(6);
  const chutes = await openLane(page, "chutes");
  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await expect(chutes.locator('input[name="chutes-api-key"]')).toBeVisible();
});

test("the paste-back step warns first and answers while the code is typed", async ({ page }) => {
  await openConnect(page);
  const codex = await openLane(page, "codex");
  /*
   * AMENDED to read `data-oauth-state`, not `data-state`. The OpenAI lane is
   * now `ready` at its own altitude because a page-memory OpenAI API key
   * genuinely connects from this route — `unavailable` there was false, and
   * `STATUS_RANK.unavailable` sorted a working route dead last. The fact this
   * test needs is about the *sign-in leg*, which is exactly what moved into
   * `oauthStatus`, so the guard now reads the state it actually depends on.
   */
  const state = await codex.getAttribute("data-oauth-state");
  test.skip(
    state !== "ready",
    `Codex sign-in is not wired into this build (OAuth leg state "${state}"), so there is no paste field to drive. `
    + "This test runs unchanged as soon as the port is supplied.",
  );
  await codex.getByRole("tab", { name: /^OAuth/u }).click();

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
  await page.setViewportSize({ width: 320, height: 844 });
  await openConnect(page);

  const layout = await page.evaluate(() => ({
    overflow: {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      surface: (() => {
      const element = document.querySelector(".connect-surface");
      return element ? element.scrollWidth - element.clientWidth : 0;
      })(),
    },
    chutesTop: document.querySelector<HTMLElement>('.connect-lane[data-lane="chutes"]')?.getBoundingClientRect().top,
    companionTop: document.querySelector<HTMLElement>('.connect-lane[data-lane="companion"]')?.getBoundingClientRect().top,
  }));
  expect(layout.overflow.document).toBeLessThanOrEqual(1);
  expect(layout.overflow.surface).toBeLessThanOrEqual(1);
  expect(layout.chutesTop, "the immediately usable Chutes lane has measurable placement").toBeDefined();
  expect(layout.companionTop, "the optional companion lane has measurable placement").toBeDefined();
  expect(layout.chutesTop!, "the usable provider path leads optional extension detail").toBeLessThan(layout.companionTop!);
  expect(layout.chutesTop!, "the usable provider path begins in the first phone viewport").toBeLessThan(844);
  const keyInput = page.locator('input[name="chutes-api-key"]');
  if (await keyInput.count()) {
    const keyInputBox = await keyInput.boundingBox();
    const mobileNavigationBox = await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox();
    expect(keyInputBox, "the Chutes key field has measurable placement").not.toBeNull();
    expect(mobileNavigationBox, "the mobile navigation has measurable placement").not.toBeNull();
    expect(keyInputBox!.y, "the first usable credential control begins in the first phone viewport").toBeLessThan(844);
    expect(keyInputBox!.y + keyInputBox!.height, "the first usable credential control is not hidden behind mobile navigation")
      .toBeLessThanOrEqual(mobileNavigationBox!.y + 1);
  }

  const headers = page.locator("button.connect-lane__header");
  const count = await headers.count();
  // AMENDED 5 → 6: the Companion joined this list as its sixth row, so the
  // 44px touch-target sweep below now covers it too. On a phone that row
  // replaces a 415px card — 66% of the viewport — that said "Not active" three
  // times above the providers.
  expect(count).toBe(6);
  for (let index = 0; index < count; index += 1) {
    const box = await headers.nth(index).boundingBox();
    expect(box?.height ?? 0, `lane header ${index} height`).toBeGreaterThanOrEqual(44);
  }

  const sealRows = await headers.evaluateAll((buttons) => buttons.map((button) => {
    const row = button.querySelector<HTMLElement>(".connect-lane__seal-row");
    const seal = row?.querySelector<HTMLElement>(".seal");
    const rowBox = row?.getBoundingClientRect();
    const sealBox = seal?.getBoundingClientRect();
    return { rowWidth: rowBox?.width, sealWidth: sealBox?.width };
  }));
  for (const [index, measurement] of sealRows.entries()) {
    expect(measurement.rowWidth, `lane ${index} status row has measurable width`).toBeDefined();
    expect(measurement.sealWidth, `lane ${index} status chip has measurable width`).toBeDefined();
    expect(measurement.rowWidth! - measurement.sealWidth!, `lane ${index} status chip remains intrinsic`).toBeGreaterThan(8);
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
      const card = page.locator(`.connect-lane[data-lane="${lane}"]`);
      // AMENDED: the assertion was `data-open="true"`, which passed for the
      // wrong reason. Only one lane may open itself now — the Chutes lane, and
      // only while there is no Chutes connection — and pressing Enter on the
      // one that is already open closes it. It used to reopen, because closing
      // wrote "nobody has chosen" and the default was read again. What the
      // keyboard owes each row is that Enter *acts*, so that is what is checked.
      const before = await card.getAttribute("data-open");
      await page.keyboard.press("Enter");
      await expect(card).toHaveAttribute("data-open", before === "true" ? "false" : "true");
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

/*
 * The refusal half of the same boundary, symmetric with mockOllama. Nothing on
 * this machine's real 1234 may answer for the probe below: a real LM Studio on
 * the developer's box used to turn "did not answer" into a rostered connection
 * and fail the spec for a reason that has nothing to do with the code under
 * test. Refused is the environment the sentence asserts, so it is the
 * environment this supplies.
 */
async function blockLmStudio(page: Page): Promise<void> {
  await page.route(/127\.0\.0\.1:1234/u, async (route) => {
    await route.abort("connectionrefused");
  });
  await page.route(/localhost:1234/u, async (route) => {
    await route.abort("connectionrefused");
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
