import { expect, test, type Page, type Route } from "@playwright/test";

const DISPLAY_PREFERENCES = JSON.stringify({
  mode: "dark",
  typeScale: "default",
  density: "comfortable",
  corners: "subtle",
  bodyFont: "system-sans",
  vaultBackend: "ephemeral",
  approvalMode: "ask-first",
});

const STOCK_CLOUD_PROVIDERS = Object.freeze([
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["xai", "xAI"],
  ["chutes", "Chutes"],
] as const);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", preferences);
  }, DISPLAY_PREFERENCES);
});

async function openProviders(page: Page): Promise<void> {
  await page.goto("/#connection");
  await expect(page).toHaveURL(/#connection$/u);
  await expect(page.locator(".topbar-destination")).toHaveText("Providers");
  await expect(page.getByRole("heading", { name: "Cloud and local models", level: 2 })).toBeVisible();
  await expect(page.locator(".provider-fabric")).toBeVisible();
}

function customProviderForm(page: Page) {
  return page.locator("form.provider-setup-card--custom");
}

test("Providers exposes four ordinary browser-direct API-key presets and no account lane", async ({ page }) => {
  await openProviders(page);

  const main = page.getByRole("main");
  await expect(main.getByRole("tablist")).toHaveCount(0);
  await expect(main.locator('a[href="#account"]')).toHaveCount(0);
  await expect(main.getByRole("tab", { name: /OAuth|Account/u })).toHaveCount(0);

  await expect(page.locator(".provider-fabric__cloud-grid > .provider-setup-card")).toHaveCount(5);
  for (const [id, label] of STOCK_CLOUD_PROVIDERS) {
    const card = page.locator(`#provider-setup-${id}`);
    await expect(card.getByRole("heading", { name: label, level: 4, exact: true })).toBeVisible();
    await expect(card.getByLabel(`${label} API key · page memory only`, { exact: true })).toHaveAttribute("type", "password");
    await expect(card.getByRole("checkbox", { name: /I accept this browser-direct credential boundary/u })).toBeVisible();
    await expect(card.getByRole("button", { name: `Connect ${label}`, exact: true })).toBeDisabled();
    await expect(card.getByText("API key · page memory", { exact: true })).toBeVisible();
  }

  await expect(customProviderForm(page).getByRole("heading", {
    name: "OpenAI-compatible endpoint",
    level: 4,
  })).toBeVisible();
});

test("a real custom OpenAI-compatible form submits with Enter and discovers its live model catalog", async ({ page }) => {
  const catalogUrl = "https://models.e2e.example/v1/models";
  let catalogReads = 0;
  await page.route(catalogUrl, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    catalogReads += 1;
    expect(route.request().headers().authorization).toBe("Bearer sk-custom-enter-e2e");
    await cors(route, 200, JSON.stringify({
      object: "list",
      data: [{
        id: "custom-chat-e2e",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        supported_features: ["tools", "reasoning"],
      }],
    }), "application/json");
  });

  await openProviders(page);
  const form = customProviderForm(page);
  await form.getByLabel("Provider name", { exact: true }).fill("E2E Custom");
  await form.getByLabel("API base URL · HTTPS", { exact: true }).fill("https://models.e2e.example/v1/");
  const key = form.getByLabel("API key · page memory only", { exact: true });
  await key.fill("sk-custom-enter-e2e");
  await form.getByRole("checkbox", { name: /I understand this tab sends the key directly/u }).check();

  // The credential is read from the input ref. It is not a successful-control
  // name that a browser could serialize into an accidental form submission.
  expect(await key.evaluate((input) => input.hasAttribute("name"))).toBe(false);
  await expect(form.getByRole("button", { name: "Connect custom endpoint" })).toBeEnabled();

  await key.press("Enter");

  const connections = page.getByRole("group", { name: "Connected inference providers" });
  const connected = connections.locator("article.provider-connection").filter({ hasText: "E2E Custom" });
  await expect(connected.getByRole("heading", { name: "E2E Custom", level: 3 })).toBeVisible();
  await expect(connected).toContainText("Page memory only");
  await expect(page.locator('.provider-fabric__notice[role="status"]'))
    .toContainText("E2E Custom is connected in page memory with 1 reported model");
  await expect(page).toHaveURL(/#connection$/u);
  expect(catalogReads).toBe(1);
});

test("custom validation routes the error to its exact field and preserves the unnamed credential", async ({ page }) => {
  await openProviders(page);
  const form = customProviderForm(page);
  await form.getByLabel("Provider name", { exact: true }).fill("Unsafe transport");
  const baseUrl = form.getByLabel("API base URL · HTTPS", { exact: true });
  await baseUrl.fill("http://provider.e2e.example/v1/");
  const key = form.getByLabel("API key · page memory only", { exact: true });
  await key.fill("sk-preserved-after-validation");
  await form.getByRole("checkbox", { name: /I understand this tab sends the key directly/u }).check();

  // Enter exercises the form submit path. HTTP is syntactically a URL, so the
  // product validator, rather than the browser's native required check, owns
  // the refusal and its focus destination.
  await key.press("Enter");

  const error = form.locator(".provider-setup-card__error");
  await expect(error).toContainText("Provider base URL must use HTTPS.");
  await expect(error).toContainText("Correct the marked field");
  await expect(baseUrl).toHaveAttribute("aria-invalid", "true");
  await expect(baseUrl).toBeFocused();
  await expect(key).toHaveValue("sk-preserved-after-validation");
  expect(await key.evaluate((input) => input.hasAttribute("name"))).toBe(false);
  await expect(page.getByRole("group", { name: "Connected inference providers" })).toHaveCount(0);
});

test("local provider discovery keeps the full provider setup surface available", async ({ page }) => {
  await mockOllama(page);
  await openProviders(page);

  const ollama = page.locator('.provider-setup-card.local[data-provider="ollama"]');
  await expect(ollama.getByLabel("Endpoint · loopback allowlist only")).toHaveValue("http://127.0.0.1:11434");
  await ollama.getByRole("button", { name: "Check Ollama", exact: true }).click();

  const connections = page.getByRole("group", { name: "Connected inference providers" });
  const connected = connections.locator("article.provider-connection").filter({ hasText: "Ollama" });
  await expect(connected.getByRole("heading", { name: "Ollama", level: 3 })).toBeVisible();
  await expect(connected).toContainText("This machine · loopback");
  await expect(page.locator("#provider-setup-openai")).toBeVisible();
  await expect(customProviderForm(page)).toBeVisible();

  const capabilities = connected.getByRole("group", { name: "Capabilities reported for the selected model" });
  /*
   * The same card, one gesture apart, used to contradict itself.
   *
   * Measured on the built tree at 3114a9b against this exact catalog: the card
   * opened reading "The model catalog did not report capabilities", and
   * choosing a model in the picker directly above it — no reload — printed
   * Text input, Text output and Tools from the catalog the sentence had just
   * blamed. The card opens with nothing selected; that is what the sentence
   * was describing, and it named the wrong cause for it.
   */
  await expect(capabilities).toHaveText("Choose a model to see its reported capabilities");

  const model = connected.getByRole("button", { name: "Ollama model for a new pinned conversation" });
  await model.click();
  await page.getByRole("listbox", { name: "Ollama model for a new pinned conversation" })
    .getByRole("option", { name: "gemma3:latest", exact: true })
    .click();
  await expect(capabilities).toContainText("Text input");
  await expect(capabilities).toContainText("Text output");
  await expect(capabilities).toContainText("Tools");
  await expect(capabilities).not.toContainText("did not report capabilities");
});

test("every cloud provider form is reachable by keyboard alone", async ({ page }) => {
  await openProviders(page);

  const expected = ["custom", "provider-setup-openai", "provider-setup-anthropic", "provider-setup-xai", "provider-setup-chutes"];
  const reached = new Set<string>();
  await customProviderForm(page).getByLabel("Provider name", { exact: true }).focus();

  for (let step = 0; step < 60 && reached.size < expected.length; step += 1) {
    const card = await page.evaluate(() => {
      const owner = document.activeElement?.closest<HTMLElement>(".provider-setup-card");
      if (!owner) return "";
      return owner.id || (owner.classList.contains("provider-setup-card--custom") ? "custom" : "");
    });
    if (card) reached.add(card);
    await page.keyboard.press("Tab");
  }

  expect([...reached].sort()).toEqual([...expected].sort());
});

test("the Providers setup stays contained and its actions keep the pointer-appropriate control floor", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openProviders(page);

  const geometry = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".provider-fabric");
    const grid = document.querySelector<HTMLElement>(".provider-fabric__cloud-grid");
    const cards = [...document.querySelectorAll<HTMLElement>(".provider-fabric__cloud-grid > .provider-setup-card")];
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      surfaceOverflow: surface ? surface.scrollWidth - surface.clientWidth : Number.POSITIVE_INFINITY,
      gridOverflow: grid ? grid.scrollWidth - grid.clientWidth : Number.POSITIVE_INFINITY,
      cards: cards.map((card) => {
        const box = card.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      }),
    };
  });

  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.surfaceOverflow).toBeLessThanOrEqual(1);
  expect(geometry.gridOverflow).toBeLessThanOrEqual(1);
  expect(geometry.cards).toHaveLength(5);
  for (const [index, card] of geometry.cards.entries()) {
    expect(card.left, `cloud card ${index} stays inside the viewport`).toBeGreaterThanOrEqual(-1);
    expect(card.right, `cloud card ${index} stays inside the viewport`).toBeLessThanOrEqual(321);
    expect(card.width, `cloud card ${index} has a measurable width`).toBeGreaterThan(0);
  }

  const actions = page.locator(".provider-fabric__cloud-grid > .provider-setup-card > button");
  await expect(actions).toHaveCount(5);
  const controlFloor = await page.evaluate(() => matchMedia("(pointer: coarse)").matches ? 44 : 40);
  for (let index = 0; index < await actions.count(); index += 1) {
    const box = await actions.nth(index).boundingBox();
    expect(box?.height ?? 0, `cloud action ${index} control height`).toBeGreaterThanOrEqual(controlFloor);
  }
});

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
          digest: "sha256:providers-current-acceptance",
          modified_at: "2026-07-20T00:00:00Z",
          capabilities: ["completion", "tools"],
          details: {
            format: "gguf",
            family: "gemma3",
            parameter_size: "4.3B",
            quantization_level: "Q4_K_M",
          },
        }],
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
      "Access-Control-Allow-Headers": "authorization,content-type,x-api-key,anthropic-version",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": contentType,
    },
  });
}
