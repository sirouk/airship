import { expect, test, type Page } from "@playwright/test";

/**
 * Account shows the accounts you have, not the accounts you could have.
 *
 * This file used to assert the opposite — four tabs on an account with nothing
 * connected, three of which could only say "Not connected" over six em dashes.
 * That is the provider catalog rendered as if it were the reader's inventory,
 * and on a first run it is the route's loudest statement that the product is
 * empty. The strip now draws a provider only where a credential is held.
 */

/** The one boundary stubbed here: OpenAI's own model catalog. */
async function stubOpenAiCatalog(page: Page) {
  await page.route("https://api.openai.com/v1/models", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ object: "list", data: [{ id: "gpt-e2e", object: "model", owned_by: "openai" }] }),
  }));
}

test("Account offers no provider tab until a provider is connected", async ({ page }) => {
  await page.goto("/#account");
  await expect(page.getByRole("heading", { name: "Account", exact: true, level: 1 })).toBeVisible();

  // No connection, so no strip at all: a tablist of zero tabs is chrome
  // describing an absence the gate below already states in words, with the
  // action attached.
  await expect(page.getByRole("tablist", { name: "Account providers" })).toHaveCount(0);
  await expect(page.getByText("Not connected yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Chutes" })).toBeVisible();
  /*
   * The catalog is not named anywhere on the route either. The inventory
   * arrives with the inference fabric, which boots asynchronously, so this is a
   * retrying assertion: it has to still hold after the fabric has spoken, not
   * only on the first paint.
   */
  await expect(page.locator(".billing-view")).not.toContainText(/OpenAI|Anthropic|xAI/u);
});

test("connecting one provider gives Account exactly that one tab", async ({ page }) => {
  await stubOpenAiCatalog(page);
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  // The route header's ⓘ auto-opens on a route's first visit and is anchored
  // over the surface beneath it, so it is dismissed the way a person dismisses
  // it before anything below is driven.
  await page.keyboard.press("Escape");

  const card = page.locator("#provider-setup-openai");
  await card.scrollIntoViewIfNeeded();
  await card.locator('input[type="password"]').fill("sk-e2e-page-memory");
  await card.locator('input[type="checkbox"]').check();
  await card.getByRole("button", { name: /^Connect OpenAI$/u }).click();
  await expect(card.getByRole("button", { name: "Connected above" })).toBeVisible();

  await page.goto("/#account");
  const tabs = page.getByRole("tablist", { name: "Account providers" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab")).toHaveText("OpenAIConnected");
  await expect(tabs.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  // Chutes is not connected here, so it has no tab — and therefore no panel
  // left to carry a "Connected" sentence about a credential nobody holds.
  await expect(tabs.getByRole("tab", { name: /Chutes/u })).toHaveCount(0);
  await expect(page.getByText("Not connected yet")).toHaveCount(0);

  // The panel that tab opens is the one this route can honestly fill: Airship
  // reads account telemetry from Chutes only, so identity, quota, usage, reset,
  // account management and the observation stamp each state that they were not
  // provided rather than showing a zero.
  const openAi = page.getByRole("tabpanel", { name: /OpenAI/u });
  await expect(openAi.getByRole("heading", { name: "OpenAI", level: 2 })).toBeVisible();
  await expect(openAi).not.toContainText("Connection state was not supplied to this view.");
  await expect(openAi).toContainText("it made no OpenAI account request from this browser");
  await expect(openAi.getByText("Not provided", { exact: true })).toHaveCount(6);
  await expect(openAi).not.toContainText("0");
});
