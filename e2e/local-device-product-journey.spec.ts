import { expect, test } from "@playwright/test";

const PREFERENCES_KEY = "airship.display-preferences.v1";

test.describe("Local Device Vault product journey", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({
        mode: "dark",
        typeScale: "default",
        density: "comfortable",
        corners: "subtle",
        bodyFont: "system-sans",
        vaultBackend: "local-device",
        approvalMode: "ask-first",
      }));
    }, { key: PREFERENCES_KEY });
  });

  test("creates, adopts, backs up, indexes, and reopens encrypted device state", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "The mobile project covers presentation separately; one Chromium origin owns this persistence ceremony.",
    );
    await page.goto("/#vault");

    const setup = page.locator(".local-device-vault");
    await expect(setup.getByRole("heading", { name: "Local Device Vault" })).toBeVisible();
    await setup.getByRole("button", { name: "Create new" }).click();

    const recovery = setup.getByLabel("One-time Local Device recovery key");
    await expect(recovery).toHaveText(/^airship-wrk-v1\.[A-Za-z0-9_-]{43}$/u);
    await setup.getByRole("checkbox", {
      name: /I saved this recovery key outside Airship/u,
    }).click();
    await expect(recovery).toHaveCount(0);
    await setup.getByRole("button", { name: "Create encrypted Vault" }).click();

    await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Local Device · encrypted and offline")).toBeVisible();
    await expect(page.getByRole("button", { name: /Local Device Vault active/u })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await setup.getByRole("button", { name: "Download backup" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^airship-local-device-\d{4}-\d{2}-\d{2}\.airship-vault$/u);
    expect(await download.failure()).toBeNull();

    const publish = page.getByRole("button", { name: "Publish encrypted index" });
    if (await publish.isVisible()) {
      await publish.click();
      await expect(page.getByText(/Encrypted context generation published|There are no indexable workspace chunks/u))
        .toBeVisible({ timeout: 20_000 });
    }

    await page.reload();
    await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Local Device · encrypted and offline")).toBeVisible();
  });

  test("keeps the complete Vault controls usable at a phone viewport", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "Mobile-only responsive assertion.");
    await page.goto("/#vault");

    await expect(page.getByRole("heading", { name: "Vault", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Local Device Vault" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create new" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  });
});
