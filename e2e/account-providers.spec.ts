import { expect, test } from "@playwright/test";

test("Account keeps every provider reachable without inventing telemetry", async ({ page }) => {
  await page.goto("/#account");
  await expect(page.getByRole("heading", { name: "Account standing", level: 1 })).toBeVisible();

  const tabs = page.getByRole("tablist", { name: "Account providers" });
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  // The shell owns the connection fact and now hands it to this route, so a
  // cloud provider with no page-memory connection reads as not connected. It
  // read "Unavailable" — the default written for "the host said nothing" —
  // until App produced the inventory at all.
  // The inventory arrives with the inference fabric, which boots asynchronously;
  // `allTextContents` below is a single read, so wait on a retrying assertion
  // first rather than racing the first paint's honest "Unavailable".
  await expect(tabs.getByRole("tab", { name: /OpenAI/u })).toHaveText("OpenAINot connected");
  await expect(tabs.getByRole("tab").allTextContents()).resolves.toEqual([
    "ChutesNot connected",
    "OpenAINot connected",
    "AnthropicNot connected",
    "xAINot connected",
  ]);
  await expect(tabs.getByRole("tab", { name: /Chutes/u })).toHaveAttribute("aria-selected", "true");

  await tabs.getByRole("tab", { name: /OpenAI/u }).click();
  const openAi = page.getByRole("tabpanel", { name: /OpenAI/u });
  await expect(openAi.getByRole("heading", { name: "OpenAI", level: 2 })).toBeVisible();
  await expect(openAi).not.toContainText("Connection state was not supplied to this view.");
  await expect(openAi).toContainText("No connected account is currently represented in this inventory.");
  // Authenticated identity, quota, usage, reset, account management, inventory
  // observed: six rows that were never read, each stating that rather than
  // omitting itself. The state chip above them now states a known fact.
  await expect(openAi.getByText("Unavailable", { exact: true })).toHaveCount(6);
  await expect(openAi).not.toContainText("0");

  await tabs.getByRole("tab", { name: /OpenAI/u }).press("End");
  await expect(tabs.getByRole("tab", { name: /xAI/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: /xAI/u })).toBeVisible();

  await tabs.getByRole("tab", { name: /xAI/u }).press("Home");
  await expect(tabs.getByRole("tab", { name: /Chutes/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Not connected yet")).toBeVisible();
});
