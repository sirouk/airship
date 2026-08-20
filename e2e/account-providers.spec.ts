import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Account is no longer a product destination. Provider discovery and
 * page-memory credentials live on the Setup / Providers destination instead.
 */

async function openProviders(page: Page): Promise<void> {
  await page.goto("/#connection");
  await expect(page).toHaveURL(/#connection$/u);
  await expect(page.locator(".topbar-destination")).toHaveText("Providers");
  await expect(page.getByRole("heading", { name: "Cloud and local models", level: 2 })).toBeVisible();
}

async function stubOpenAiCatalog(
  page: Page,
  response: (attempt: number) => Readonly<{ status: number; body: unknown }>,
): Promise<() => number> {
  let attempts = 0;
  await page.route("https://api.openai.com/v1/models", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    attempts += 1;
    const next = response(attempts);
    await cors(route, next.status, JSON.stringify(next.body), "application/json");
  });
  return () => attempts;
}

test("the retired Account address resolves away and Setup exposes Providers instead", async ({ page }) => {
  await page.goto("/#account");

  await expect(page).toHaveURL(/#chat(?:\/[^?#]+)?$/u);
  await expect(page.locator(".topbar-destination")).toHaveText("Chat");
  await expect(page.getByRole("main").getByRole("heading", { name: "Account", exact: true })).toHaveCount(0);
  await expect(page.locator(".billing-view")).toHaveCount(0);
  await expect(page.locator('a[href="#account"]')).toHaveCount(0);

  await openProviders(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("tablist")).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Cloud providers", level: 3 })).toBeVisible();
  await expect(main.getByText("Configure cloud API keys", { exact: true })).toBeVisible();
});

test("OpenAI discovery creates a current Providers connection without an account tab", async ({ page }) => {
  const attempts = await stubOpenAiCatalog(page, () => ({
    status: 200,
    body: { object: "list", data: [{ id: "gpt-e2e-current", object: "model", owned_by: "openai" }] },
  }));
  await openProviders(page);

  const card = page.locator("#provider-setup-openai");
  const key = card.getByLabel("OpenAI API key · page memory only", { exact: true });
  const acknowledgement = card.getByRole("checkbox", { name: /I accept this browser-direct credential boundary/u });
  await key.fill("sk-openai-current-product");
  await acknowledgement.check();
  await card.getByRole("button", { name: "Connect OpenAI", exact: true }).click();

  const connections = page.getByRole("group", { name: "Connected inference providers" });
  const openAi = connections.locator("article.provider-connection").filter({ hasText: "OpenAI" });
  await expect(openAi.getByRole("heading", { name: "OpenAI", level: 3 })).toBeVisible();
  await expect(openAi).toContainText("Page memory only");
  await expect(card.getByRole("button", { name: "Connected above" })).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(acknowledgement).not.toBeChecked();

  const modelControl = openAi.getByRole("button", { name: "OpenAI model for a new pinned conversation" });
  await modelControl.click();
  const modelOption = page.getByRole("listbox", { name: "OpenAI model for a new pinned conversation" })
    .getByRole("option", { name: "gpt-e2e-current", exact: true });
  await expect(modelOption).toHaveAccessibleDescription(/Provider catalog · availability unknown/u);
  await modelOption.click();
  await expect(openAi.getByRole("group", { name: "Capabilities reported for the selected model" }))
    .toContainText("The model catalog did not report capabilities");

  await expect(page.getByRole("main").getByRole("tablist")).toHaveCount(0);
  await expect(page.locator(".billing-view")).toHaveCount(0);
  expect(attempts()).toBe(1);
});

test("a refused stock credential remains editable and clears only after successful discovery", async ({ page }) => {
  const attempts = await stubOpenAiCatalog(page, (attempt) => attempt === 1
    ? {
        status: 401,
        body: { error: { message: "Credential rejected for this acceptance check." } },
      }
    : {
        status: 200,
        body: { object: "list", data: [{ id: "gpt-recovered-current", object: "model", owned_by: "openai" }] },
      });
  await openProviders(page);

  const card = page.locator("#provider-setup-openai");
  const key = card.getByLabel("OpenAI API key · page memory only", { exact: true });
  const acknowledgement = card.getByRole("checkbox", { name: /I accept this browser-direct credential boundary/u });
  const connect = card.getByRole("button", { name: "Connect OpenAI", exact: true });
  await key.fill("sk-refused-but-preserved");
  await acknowledgement.check();
  await connect.click();

  const failure = card.locator(".provider-setup-card__error");
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute("role", "alert");
  await expect(failure).toContainText("Your credential and acknowledgement were kept.");
  await expect(key).toHaveValue("sk-refused-but-preserved");
  await expect(key).toBeFocused();
  await expect(acknowledgement).toBeChecked();
  await expect(connect).toBeEnabled();
  expect(await connect.getAttribute("aria-describedby")).toBe(await failure.getAttribute("id"));
  await expect(page.getByRole("group", { name: "Connected inference providers" })).toHaveCount(0);

  await connect.click();
  await expect(card.getByRole("button", { name: "Connected above" })).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(acknowledgement).not.toBeChecked();
  await expect(failure).toHaveCount(0);
  expect(attempts()).toBe(2);
});

async function cors(route: Route, status: number, body: string, contentType = "text/plain"): Promise<void> {
  await route.fulfill({
    status,
    body,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Content-Type": contentType,
    },
  });
}
