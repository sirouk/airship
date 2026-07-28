import { expect, test } from "@playwright/test";

test("an adopted S3 runtime is quiesced before Drive becomes authoritative", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one live local-vault transition is sufficient");
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
  const namespace = `airship-live-v2/e2e/${testInfo.project.name}-provider-switch-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#vault`);
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 25_000 });

  const provider = page.getByRole("button", { name: "Vault storage provider" });
  await expect(provider).toContainText("S3-compatible / MinIO");
  await provider.click();
  const driveOption = page.getByRole("option", { name: /^Google Drive/ });
  const optionBackground = await driveOption.evaluate((element) => getComputedStyle(element).backgroundColor);
  const actionBackground = await page.locator(".vault-view__actions > button").first().evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(optionBackground).not.toBe(actionBackground);
  const titleBox = await driveOption.locator("strong").boundingBox();
  const descriptionBox = await driveOption.locator("small").boundingBox();
  expect(titleBox).not.toBeNull();
  expect(descriptionBox?.y).toBeGreaterThan(titleBox!.y);
  await driveOption.click();
  await expect(provider).toBeEnabled({ timeout: 20_000 });

  await expect(provider).toContainText("Google Drive", { timeout: 20_000 });
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Connect your Google Drive" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("airship.display-preferences.v1") ?? "null")?.vaultBackend)).toBe("google-drive");

  await provider.click();
  await page.getByRole("option", { name: /^Ephemeral/u }).click();
  await expect(provider).toContainText("Ephemeral");
  await expect(page.getByText("No endpoint, credential authority, or workspace key is attached.")).toBeVisible();
});
