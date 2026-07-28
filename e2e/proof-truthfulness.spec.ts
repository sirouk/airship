import { expect, test } from "@playwright/test";

test("disconnected Proof navigation and empty evidence state describe the real available action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one proof navigation contract is sufficient");
  await page.goto("/#chat");
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Summarize this deterministic demo.");
  await page.getByRole("button", { name: "Send message" }).click();

  const inspector = page.locator(".inspector");
  const inspectEvidence = inspector.getByRole("button", { name: "Inspect evidence" });
  await expect(inspectEvidence).toBeVisible();
  await expect(inspector.getByRole("button", { name: /Acquire endpoint evidence/u })).toHaveCount(0);
  await inspectEvidence.click();

  await expect(page).toHaveURL(/#proof\?.*section=attestations/u);
  await expect(page.getByRole("heading", { name: "Endpoint & receipt evidence", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh evidence" })).toBeDisabled();

  // A receipt is itself a ledger record, so reload a genuinely empty
  // page-memory session before checking the empty-state acquisition handoff.
  await page.goto("/?emptyProofLedger=1#proof?section=attestations");
  await expect(page.getByRole("heading", { name: "No evidence records yet", level: 2 })).toBeVisible();
  await expect(page.getByText("No Chutes inference provider is connected.", { exact: false })).toBeVisible();
  await expect(page.getByText("Connect Chutes inference, then fetch fresh endpoint evidence", { exact: false })).toBeVisible();

  const connect = page.getByRole("button", { name: "Connect inference" });
  await expect(connect).toBeVisible();
  await connect.click();
  await expect(page).toHaveURL(/#connection$/u);
  await expect(page.getByRole("heading", { name: "Connect models" })).toBeVisible();
});
