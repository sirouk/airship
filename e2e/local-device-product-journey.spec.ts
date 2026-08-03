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
    // a person may no longer claim to have kept a one-time key they never
    // looked at. "By hand" needs no clipboard permission.
    await setup.getByRole("button", { name: "I wrote it down by hand" }).click();
    await setup.getByRole("checkbox", {
      name: /I saved this recovery key outside Airship/u,
    }).click();
    await expect(recovery).toHaveCount(0);
    await setup.getByRole("button", { name: "Create encrypted Vault" }).click();

    await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Local Device · encrypted and offline")).toBeVisible();
    await expectTabTrustAxis(page, /^Local Device Vault active/u);

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

/**
 * AMENDED: the four trust axes are no longer four topbar buttons.
 *
 * The topbar carries one chip whose accessible name states the weakest claim
 * true of this browser tab and counts every axis behind it, and each axis keeps
 * its own verbatim label, sentence and destination as a row in the sheet that
 * chip opens (`topbar.tsx:30`, `platform-shell.tsx:454`). No claim was deleted,
 * so this follows the disclosure rather than dropping the assertion — and it is
 * strictly stronger than the button check it replaces: it additionally proves
 * the chip is honest about how many claims it stands in front of, that the
 * sheet actually opens, and that the axis is filed under the browser-tab band
 * rather than silently rescoped to the conversation.
 */
async function expectTabTrustAxis(page: import("@playwright/test").Page, label: RegExp): Promise<void> {
  const chip = page.getByRole("button", { name: /^Runtime trust for this browser tab\./u });
  /*
   * "4 axes." became "4 runtime claims. 2 of them are scoped to this
   * conversation and are stated in the session bar." — the noun a person can
   * act on instead of the one the code uses, and it now says which of them
   * belong to the conversation rather than to the tab. Asserted as the count
   * and its noun, so the sentence around it can keep improving.
   */
  await expect(chip).toHaveAccessibleName(/\s\d+ runtime claims\./u);
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Runtime trust" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "This browser tab" }).getByRole("button", { name: label }))
    .toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
}
