import { expect, test } from "@playwright/test";

test("a provider that cannot be opened cannot detach the adopted runtime", async ({ page }, testInfo) => {
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

  /*
   * AMENDED, and strictly stronger than the journey it replaces.
   *
   * This test used to select Drive and watch the adopted S3 runtime be
   * quiesced before Drive became authoritative. That journey depended on Drive
   * being selectable in a build that cannot open it — no client ID is
   * configured here — and selecting it released the attached Vault *before*
   * anything asked whether the destination could be opened. A validated audit
   * finding named exactly that, and the fix makes availability a selectability
   * fact: the rung is still offered and still explains itself, but it cannot be
   * chosen, so there is nothing to quiesce.
   *
   * So the safety property is now proven by construction rather than by
   * observing a careful teardown: the option is disabled, it says why, pressing
   * it changes nothing, and the adopted runtime is still the authority
   * afterwards. That is a guarantee the old sequence could not make.
   */
  await expect(driveOption).toBeDisabled();
  await expect(driveOption.locator("small")).not.toBeEmpty();
  // A disabled control cannot be clicked through Playwright's actionability
  // checks, so the event is dispatched directly — the point is that even a raw
  // click reaches nothing.
  await driveOption.dispatchEvent("click");
  await expect(provider).toContainText("S3-compatible / MinIO");
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("airship.display-preferences.v1") ?? "null")?.vaultBackend)).toBe("local-lab");
  await page.keyboard.press("Escape");

  await provider.click();
  await page.getByRole("option", { name: /^Ephemeral/u }).click();
  await expect(provider).toContainText("Ephemeral");
  await expect(page.getByText("No endpoint, credential authority, or workspace key is attached.")).toBeVisible();
});
