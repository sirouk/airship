import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

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
  const invokedModels: string[] = [];
  await mockOllama(page, async (route) => {
    const body = route.request().postDataJSON() as { model?: unknown };
    if (typeof body.model === "string") invokedModels.push(body.model);
    await cors(route, 200, ollamaSse("OK"), "text/event-stream");
  });
  await setProfilePresentationDensity(page, "Balanced");
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
   * The active provider is named on the conversation-model control, while the
   * selected model remains visible as its value. The name also states that a
   * new selection changes this conversation in place.
   */
  const modelChip = page.getByRole("button", { name: /Ollama conversation model/u });
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
  const response = page.locator(".message.assistant").last();
  await expect(response).toContainText("OK", { timeout: 20_000 });

  // A completed local-provider turn keeps neutral provider, model, and run-id
  // metadata with the answer.
  const runDetails = response.getByRole("button", { name: /^Run details\. Provider /u });
  await expect(runDetails).toBeVisible({ timeout: 20_000 });
  await expect(runDetails).toContainText(/^Run · .+ · .+$/u);
  await runDetails.click();
  const runPanel = response.getByRole("group", { name: "Run details" });
  await expect(runPanel.locator('[data-field="origin"]')).toContainText("Local run record");
  await expect(runPanel.locator('[data-field="model"] code')).toHaveText("gemma3:latest");
  await runPanel.getByRole("button", { name: "Done" }).click();

  // The durable model override projects onto the exact same connection. The
  // next turn and its trace use qwen without changing the Profile default or
  // weakening the provider/transport/protocol pins.
  await modelChip.click();
  await page.getByRole("listbox", { name: /Ollama conversation model/u })
    .getByRole("option", { name: "qwen3:latest" })
    .click();
  await expect(modelChip).toContainText("qwen3", { timeout: 20_000 });
  await composer.fill("Reply after the in-place model change.");
  await composer.press("Enter");
  const switchedResponse = page.locator(".message.assistant").last();
  await expect(switchedResponse).toContainText("OK", { timeout: 20_000 });
  const switchedRunDetails = switchedResponse.getByRole("button", { name: /^Run details\. Provider /u });
  await switchedRunDetails.click();
  await expect(switchedResponse.getByRole("group", { name: "Run details" }).locator('[data-field="model"] code'))
    .toHaveText("qwen3:latest");
  expect(invokedModels.at(-1)).toBe("qwen3:latest");

  const conversationUrl = page.url();
  await page.goto("/#connection");
  const fabricAfterTurn = page.locator(".provider-fabric");
  const activeCard = fabricAfterTurn.locator("article.provider-connection", { hasText: "Ollama" });
  await activeCard.getByRole("button", { name: "Disconnect" }).click();
  await expect(activeCard.getByText(/conversation stays readable/u)).toBeVisible();
  await activeCard.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(activeCard).toHaveCount(0);
  await expect(fabricAfterTurn.locator(".provider-fabric__notice")).toContainText(
    "Ollama was released from page memory. This conversation remains readable and permanently pinned to that released generation",
  );

  // The released route stays visible as a read-only session pin. A refused
  // send leaves the operator's prompt in place and names the exact recovery.
  await page.getByRole("button", { name: "Open session" }).click();
  await expect(page).toHaveURL(conversationUrl);
  const releasedModel = page.getByRole("button", { name: /Ollama session model/u });
  await expect(releasedModel).toContainText("qwen3");
  const preservedPrompt = "Keep this prompt while the local route is released.";
  await composer.fill(preservedPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(composer).toHaveValue(preservedPrompt);
  await expect(page.locator(".composer-notice")).toContainText(
    /remains read-only; reconnect its exact provider connection to continue/u,
  );
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
    if (chatRequests === 1) {
      await new Promise<void>((resolve) => {
        releaseActiveTurn = resolve;
      });
      await route.abort("aborted").catch(() => {});
      return;
    }
    await cors(
      route,
      200,
      ollamaSse("SENT_BY_PERSON"),
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
  expect(chatRequests).toBe(0);

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("active slow turn");
  await composer.press("Enter");
  await expect.poll(() => chatRequests).toBe(1);
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

  expect(chatRequests).toBe(1);
  await expect(page.locator(".composer-queue")).toContainText("paused after Stop");
  await context.setOffline(true);
  await page.waitForTimeout(300);
  await context.setOffline(false);
  await page.waitForTimeout(500);
  expect(chatRequests).toBe(1);
  await expect(page.locator(".composer-queue")).toBeVisible();
  await expect(page.getByRole("article", { name: "Your message" })
    .filter({ hasText: "queued follow-up must remain paused" })).toHaveCount(0);

  await page.locator(".composer-queue").getByRole("button", { name: "Send now" }).click();
  await expect.poll(() => chatRequests).toBe(2);
  await expect(page.locator(".composer-queue")).toBeHidden();
  await expect(page.getByRole("article", { name: "Your message" })
    .filter({ hasText: "queued follow-up must remain paused" })).toHaveCount(1);
});

test("Skills starts its pinned conversation while another turn is still running", async ({ page }, testInfo) => {
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
    if (chatRequests === 1) {
      await new Promise<void>((resolve) => { releaseActiveTurn = resolve; });
    }
    await cors(route, 200, ollamaSse("HELD_TURN"), "text/event-stream");
  });

  try {
    await page.goto("/#connection");
    const fabric = page.locator(".provider-fabric");
    await fabric.getByRole("button", { name: "Check Ollama" }).click();
    const connected = fabric.locator("article.provider-connection", { hasText: "Ollama" });
    await chooseOllamaModel(page, connected);
    await connected.getByRole("button", { name: "Use in new conversation" }).click();
    expect(chatRequests).toBe(0);

    const composer = page.getByRole("combobox", { name: "Message Airship" });
    await composer.fill("Hold this turn while I inspect Skills.");
    await composer.press("Enter");
    await expect.poll(() => chatRequests).toBe(1);

    // Skills and Capabilities are intentionally not permanent rail rows. The
    // profile control beside the agent name is their entry point now; opening
    // the manager first keeps this journey on the same path a person uses.
    await page.getByRole("button", { name: "Manage profiles" }).click();
    await expect(page).toHaveURL(/#profiles$/u);
    await page.getByRole("navigation", { name: "Agent configuration" })
      .getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page).toHaveURL(/#skills$/u);
    /*
     * A running turn used to disable this control and explain itself. The
     * engine always ran turns per conversation; the shell was the only thing
     * serialising them, so the honest answer is that the control works and the
     * held turn keeps running in the conversation that owns it.
     */
    const start = page.getByRole("button", { name: "New conversation with this set" });
    await expect(start).toBeEnabled();
    await expect(page.locator("#skill-conversation-start-status")).toHaveCount(0);
    await start.click();
    await expect(page).toHaveURL(/#chat/u);
    await page.screenshot({ path: testInfo.outputPath("skills-active-turn.png"), animations: "disabled" });

    // The new conversation is immediately usable, and the held turn is still
    // held in the conversation that owns it.
    const started = page.getByRole("combobox", { name: "Message Airship" });
    await expect(started).toBeEnabled();
    expect(chatRequests).toBe(1);

    releaseActiveTurn?.();
    releaseActiveTurn = undefined;
  } finally {
    releaseActiveTurn?.();
  }
});


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
        }, {
          name: "qwen3:latest",
          size: 4_200_000_000,
          digest: "sha256:model-switch-acceptance",
          modified_at: "2026-07-20T00:00:00Z",
          details: {
            format: "gguf",
            family: "qwen3",
            parameter_size: "8B",
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
