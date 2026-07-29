import { expect, test } from "@playwright/test";

test("Account keeps every provider reachable without inventing telemetry", async ({ page }) => {
  await page.goto("/#account");
  await expect(page.getByRole("heading", { name: "Account standing", level: 1 })).toBeVisible();

  const tabs = page.getByRole("tablist", { name: "Account providers" });
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await expect(tabs.getByRole("tab").allTextContents()).resolves.toEqual([
    "ChutesNot connected",
    "OpenAIUnavailable",
    "AnthropicUnavailable",
    "xAIUnavailable",
  ]);
  await expect(tabs.getByRole("tab", { name: /Chutes/u })).toHaveAttribute("aria-selected", "true");

  await tabs.getByRole("tab", { name: /OpenAI/u }).click();
  const openAi = page.getByRole("tabpanel", { name: /OpenAI/u });
  await expect(openAi.getByRole("heading", { name: "OpenAI", level: 2 })).toBeVisible();
  await expect(openAi).toContainText("Connection state was not supplied to this view.");
  await expect(openAi.getByText("Unavailable", { exact: true })).toHaveCount(6);
  await expect(openAi).not.toContainText("0");

  await tabs.getByRole("tab", { name: /OpenAI/u }).press("End");
  await expect(tabs.getByRole("tab", { name: /xAI/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: /xAI/u })).toBeVisible();

  await tabs.getByRole("tab", { name: /xAI/u }).press("Home");
  await expect(tabs.getByRole("tab", { name: /Chutes/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Not connected yet")).toBeVisible();
});
