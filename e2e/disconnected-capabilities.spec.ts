import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

test("disconnected Chat keeps local commands live and offers one clear inference handoff", async ({ page }) => {
  await page.goto("/#chat");
  const guidance = page.locator(".chat-live-guidance");
  await expect(guidance).toContainText("Slash commands work here");
  await expect(guidance).toContainText("OAuth or API key");

  await page.getByRole("combobox", { name: "Message Airship" }).fill("/help");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Local command · excluded from model context").last()).toBeVisible();

  await guidance.getByRole("button", { name: "Connect Chutes" }).click();
  await expect(page).toHaveURL(/#connection$/);
  await expect(page.getByRole("heading", { name: "Chutes access" })).toBeVisible();
});

test("Capabilities states that runtime activation is provider-independent", async ({ page }) => {
  await page.goto("/#capabilities");
  await expect(page.getByRole("heading", { name: "Capabilities" })).toBeVisible();
  await expect(page.getByText(/No inference provider—including Chutes—is required for local activation/u)).toBeVisible();
  await expect(page.getByText(/Local activation needs no model provider/u)).toBeVisible();
  await page.getByRole("button", { name: "Browse slash tools" }).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toHaveValue("/help ");
});
