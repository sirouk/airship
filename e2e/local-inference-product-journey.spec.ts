import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

const PREFERENCES_KEY = "airship.display-preferences.v1";

test("connects, pins, invokes, and disconnects an Ollama model through the mounted app", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One real Chromium transport journey is sufficient; responsive layout is covered separately.",
  );
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  }, { key: PREFERENCES_KEY });
  await mockOllama(page);
  await page.goto("/#connection");

  const fabric = page.locator(".provider-fabric");
  await expect(fabric.getByRole("heading", { name: "Cloud and local models" })).toBeVisible();
  await fabric.getByRole("button", { name: "Check Ollama" }).click();

  const connected = fabric.locator("article.provider-connection", { hasText: "Ollama" });
  await expect(connected).toContainText("This machine · loopback");
  await chooseOllamaModel(page, connected);
  await connected.getByRole("button", { name: "Use in new conversation" }).click();

  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 20_000 });
  /*
   * The control is named by the field it sets and describes its value, which is
   * the naming contract the whole product follows: a voice user says "Ollama
   * session model", and the pinned model is read out after it rather than
   * welded into the name. So the provider is asserted on the name and the model
   * id on what the chip actually shows.
   */
  const modelChip = page.getByRole("button", { name: /Ollama session model/u });
  await expect(modelChip).toBeVisible();
  await expect(modelChip).toContainText("gemma3");

  // AMENDED: the composer placeholder reads "Message Airship — / for commands"
  // now; it stopped being "Ask Airship…" when the composer started advertising
  // the slash-command entry point. Addressing the field by its accessible name
  // rather than its placeholder is stronger: the name is the contract screen
  // readers depend on, and a placeholder is free to be re-worded again without
  // this spec silently losing its grip on the control.
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("Reply with a short local greeting.");
  await composer.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("OK", { timeout: 20_000 });

  await page.goto("/#connection");
  const activeCard = page.locator(".provider-fabric article.provider-connection", { hasText: "Ollama" });
  await activeCard.getByRole("button", { name: "Disconnect" }).click();
  await expect(activeCard.getByText(/conversation stays readable/u)).toBeVisible();
  await activeCard.getByRole("button", { name: "Confirm disconnect" }).click();
  await expectConversationTrustAxis(page, /^Ollama · disconnected/u);
});

test("a stopped queue stays paused across conversation switches and reconnects", async ({ page, context }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One real Chromium queue-lifecycle journey is sufficient; responsive layout is covered separately.",
  );
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  }, { key: PREFERENCES_KEY });

  let chatRequests = 0;
  let releaseActiveTurn: (() => void) | undefined;
  await mockOllama(page, async (route) => {
    chatRequests += 1;
    if (chatRequests === 2) {
      await new Promise<void>((resolve) => {
        releaseActiveTurn = resolve;
      });
      await route.abort("aborted").catch(() => {});
      return;
    }
    await cors(
      route,
      200,
      ollamaSse(chatRequests === 1 ? "PREFLIGHT" : "SENT_BY_PERSON"),
      "text/event-stream",
    );
  });
  await page.goto("/#connection");

  const fabric = page.locator(".provider-fabric");
  await fabric.getByRole("button", { name: "Check Ollama" }).click();
  const connected = fabric.locator("article.provider-connection", { hasText: "Ollama" });
  await chooseOllamaModel(page, connected);
  await connected.getByRole("button", { name: "Use in new conversation" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 20_000 });
  await expect.poll(() => chatRequests).toBe(1);

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("active slow turn");
  await composer.press("Enter");
  await expect.poll(() => chatRequests).toBe(2);
  await composer.fill("queued follow-up must remain paused");
  await composer.press("Enter");
  await expect(page.locator(".composer-queue")).toBeVisible();
  await page.getByRole("button", { name: "Stop turn" }).click();
  releaseActiveTurn?.();
  await expect(page.locator(".composer-queue")).toContainText("paused after Stop");

  const sourceUrl = page.url();
  await page.getByRole("region", { name: "Agent session" })
    .getByRole("button", { name: "New conversation" }).click();
  await page.waitForFunction((prior) => location.href !== prior, sourceUrl);

  const navigation = page.getByRole("navigation", { name: "Primary" });
  const expand = navigation.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
  const sourceRow = navigation.locator(
    "#airship-recent-conversations .recent-conversation:not(.active)",
  ).first();
  await expect(sourceRow).toBeVisible();
  await sourceRow.click();
  await expect(page).toHaveURL(sourceUrl);

  expect(chatRequests).toBe(2);
  await expect(page.locator(".composer-queue")).toContainText("paused after Stop");
  await context.setOffline(true);
  await page.waitForTimeout(300);
  await context.setOffline(false);
  await page.waitForTimeout(500);
  expect(chatRequests).toBe(2);
  await expect(page.locator(".composer-queue")).toBeVisible();
  await expect(page.getByRole("article", { name: "Your message" })
    .filter({ hasText: "queued follow-up must remain paused" })).toHaveCount(0);

  await page.locator(".composer-queue").getByRole("button", { name: "Send now" }).click();
  await expect.poll(() => chatRequests).toBe(3);
  await expect(page.locator(".composer-queue")).toBeHidden();
  await expect(page.getByRole("article", { name: "Your message" })
    .filter({ hasText: "queued follow-up must remain paused" })).toHaveCount(1);
});

test("Skills explains why its pinned conversation cannot start during an active turn", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One deterministic held-turn journey is sufficient; responsive Skills coverage runs separately.",
  );
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  }, { key: PREFERENCES_KEY });

  let chatRequests = 0;
  let releaseActiveTurn: (() => void) | undefined;
  await mockOllama(page, async (route) => {
    chatRequests += 1;
    if (chatRequests === 2) {
      await new Promise<void>((resolve) => { releaseActiveTurn = resolve; });
    }
    await cors(route, 200, ollamaSse(chatRequests === 1 ? "PREFLIGHT" : "HELD_TURN"), "text/event-stream");
  });

  try {
    await page.goto("/#connection");
    const fabric = page.locator(".provider-fabric");
    await fabric.getByRole("button", { name: "Check Ollama" }).click();
    const connected = fabric.locator("article.provider-connection", { hasText: "Ollama" });
    await chooseOllamaModel(page, connected);
    await connected.getByRole("button", { name: "Use in new conversation" }).click();
    await expect.poll(() => chatRequests).toBe(1);

    const composer = page.getByRole("combobox", { name: "Message Airship" });
    await composer.fill("Hold this turn while I inspect Skills.");
    await composer.press("Enter");
    await expect.poll(() => chatRequests).toBe(2);

    // Skills and Capabilities are intentionally not permanent rail rows. The
    // profile control beside the agent name is their entry point now; opening
    // the manager first keeps this journey on the same path a person uses.
    await page.getByRole("button", { name: "Manage profiles" }).click();
    await expect(page).toHaveURL(/#profiles$/u);
    await page.getByRole("navigation", { name: "Agent configuration" })
      .getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page).toHaveURL(/#skills$/u);
    const start = page.getByRole("button", { name: "New conversation with this set" });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("aria-describedby", "skill-conversation-start-status");
    await expect(page.locator("#skill-conversation-start-status"))
      .toHaveText("Stop the active turn before starting a new conversation.");
    await page.screenshot({ path: testInfo.outputPath("skills-active-turn.png"), animations: "disabled" });

    releaseActiveTurn?.();
    releaseActiveTurn = undefined;
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator("#skill-conversation-start-status")).toHaveCount(0);
  } finally {
    releaseActiveTurn?.();
  }
});

/**
 * AMENDED: the four trust axes stopped rendering as four topbar pills.
 *
 * The topbar carries one chip that states the weakest claim true of this
 * browser tab and counts every axis behind it; the inference axis is scoped to
 * the conversation, so its verbatim label is stated at rest in the session bar
 * and in full in the sheet the chip opens (`topbar.tsx:30`,
 * `platform-shell.tsx:454`). This route has no session bar, which is exactly
 * why the sheet is the right place to read it from here — the claim was
 * re-presented, not deleted.
 *
 * Stronger than the button check it replaces: it additionally proves the chip
 * is honest about how many claims it hides, that the sheet opens and closes,
 * and that a released pin is still filed as a claim about *this conversation*
 * rather than quietly promoted to a property of the tab.
 */
async function expectConversationTrustAxis(page: Page, label: RegExp): Promise<void> {
  const chip = page.getByRole("button", { name: /^Runtime trust for this browser tab\./u });
  /*
   * "4 axes." became "4 runtime claims. 2 of them are scoped to this
   * conversation and are stated in the session bar." — the noun a person can
   * act on instead of the one the code uses, and it now says which of them
   * belong to the conversation rather than to the tab. Asserted as the count
   * and its noun, so the sentence around it can keep improving.
   */
  await expect(chip).toHaveAccessibleName(/\s\d+ runtime claims\./u);
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Runtime trust" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "This conversation" }).getByRole("button", { name: label }))
    .toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
}

async function mockOllama(
  page: Page,
  onChat?: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route("http://127.0.0.1:11434/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    if (url.pathname === "/api/version") {
      await json(route, { version: "0.12.3" });
      return;
    }
    if (url.pathname === "/api/tags") {
      await json(route, {
        models: [{
          name: "gemma3:latest",
          size: 3_338_801_804,
          digest: "sha256:browser-acceptance",
          modified_at: "2026-07-20T00:00:00Z",
          details: {
            format: "gguf",
            family: "gemma3",
            parameter_size: "4.3B",
            quantization_level: "Q4_K_M",
          },
        }],
      });
      return;
    }
    if (url.pathname === "/api/show") {
      await json(route, {
        capabilities: ["completion", "vision", "tools"],
        model_info: { "gemma3.context_length": 131_072 },
      });
      return;
    }
    if (url.pathname === "/v1/chat/completions") {
      if (onChat) {
        await onChat(route);
        return;
      }
      await cors(route, 200, ollamaSse("OK"), "text/event-stream");
      return;
    }
    await cors(route, 404, "not found", "text/plain");
  });
}

async function chooseOllamaModel(page: Page, connection: Locator): Promise<void> {
  const modelSelect = connection.getByRole("button", { name: "Ollama model for a new pinned conversation" });
  await modelSelect.click();
  await page.getByRole("listbox", { name: "Ollama model for a new pinned conversation" })
    .getByRole("option", { name: "gemma3:latest" })
    .click();
}

function ollamaSse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

async function json(route: Route, value: unknown): Promise<void> {
  await cors(route, 200, JSON.stringify(value), "application/json");
}

async function cors(
  route: Route,
  status: number,
  body: string,
  contentType = "text/plain",
): Promise<void> {
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
