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
    // The acknowledgement is disabled until the key has actually been saved:
    // a person may no longer confirm custody of a one-time key they never
    // looked at. "By hand" needs no clipboard permission.
    await setup.getByRole("button", { name: "I wrote it down by hand" }).click();
    await setup.getByRole("checkbox", {
      name: /I saved this recovery key outside Airship/u,
    }).click();
    await expect(recovery).toHaveCount(0);
    await setup.getByRole("button", { name: "Create encrypted Vault" }).click();

    await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Local Device · encrypted and offline")).toBeVisible();
    await expectLocalDeviceVaultReady(page);

    const downloadPromise = page.waitForEvent("download");
    // Renamed with the recovery kit: the control names the file it produces.
    await setup.getByRole("button", { name: /Download (encrypted backup|a fresh backup)/u }).click();
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
    await expectLocalDeviceVaultReady(page);
  });

  test("keeps the complete Vault controls usable at a phone viewport", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "Mobile-only responsive assertion.");
    await page.goto("/#vault");

    await expect(page.getByRole("heading", { name: "Vault", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Local Device Vault" })).toBeVisible();
    const phase = page.locator(".vault-view__phase .status-mark");
    await expect(phase).toHaveAttribute("data-state", "attention");
    await expect(phase).toHaveAccessibleName("Not set up yet");
    await expect(page.getByRole("button", { name: "Create new" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  });
});

/** The Vault route owns the current Local Device activation state. */
async function expectLocalDeviceVaultReady(page: import("@playwright/test").Page): Promise<void> {
  const phase = page.locator(".vault-view__phase .status-mark");
  await expect(phase).toHaveAttribute("data-state", "verified", { timeout: 20_000 });
  await expect(phase).toHaveAccessibleName("Encrypted device Vault ready");

  const state = page.locator(".vault-view__state");
  await expect(state).toHaveAttribute("data-state", "adopted", { timeout: 20_000 });
  const stateMark = state.locator(":scope > .status-mark");
  await expect(stateMark).toHaveAttribute("data-state", "verified");
  await expect(stateMark).toHaveAccessibleName("Ready");
  await expect(state.locator(".vault-view__state-copy")).toContainText("Local Device · encrypted and offline");
}
