import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Bringing work in on a new device, before that device has finished deciding
 * where its work lives.
 *
 * This is the first thing a person does with a bundle and it is the exact job
 * the feature exists for, and it was the one case it could not do. With a Local
 * Device Vault enrolled the page-memory runtime boots first; adoption reads that
 * journal and then replaces it. An import that lands inside that window is
 * written into the journal being replaced: the panel reported "1 conversation
 * added.", the list held the row for a moment, and after the adoption, after
 * Refresh and after a reload the row was gone, with nothing anywhere admitting a
 * loss.
 *
 * The window is real and this spec widens it rather than inventing it: the
 * auto-open effect fetches `local-device-keyring` before it can open the key, so
 * a slow disk or a cold cache is the same wait. Everything else — the enrolment,
 * the OPFS journal, the bundle file on disk, the merge — is the product.
 *
 * The second half of the journey was measured wrong for a while, and is now
 * what it says: a plan read inside that window describes the journal the
 * adoption replaces, so it is withdrawn when the storage opens rather than
 * being left on screen until its own button enables itself and contradicts it.
 * "Choose the file again" is what the refusal promises and what happens.
 */

const PARTITION = "airship-workspace-v1";

async function enrollLocalDevice(page: Page): Promise<void> {
  await page.goto("/e2e/fixtures/provider-fabric-harness.html");
  await page.waitForLoadState("networkidle");
  await page.evaluate(async ({ partition }) => {
    const { prepareLocalDeviceWorkspaceKeyEnrollment } = await import("/src/storage/local-device-keyring.ts");
    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({ partition });
    await enrollment.commit({ recoveryKeySavedAcknowledged: true });
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "local-device",
      approvalMode: "ask-first",
    }));
  }, { partition: PARTITION });
}

async function openMovePanel(page: Page, namespace: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#sessions`);
  const toggle = page.getByRole("button", { name: "Move work" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 20_000 });
}

test("an import refuses while the receiving Vault is still being adopted, and lands once it is", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one Chromium origin covers the real OPFS journal path");
  test.setTimeout(300_000);
  const stamp = Date.now().toString(36);
  const sourceNamespace = `bundle-source-${stamp}`;
  const targetNamespace = `bundle-target-${stamp}`;
  const directory = await mkdtemp(join(tmpdir(), "airship-authority-"));

  const source: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const target: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const sourcePage = await source.newPage();
  const targetPage = await target.newPage();

  try {
    // ── A device with one conversation, named by a person, in a file ────────
    await enrollLocalDevice(sourcePage);
    await sourcePage.goto(`/?airshipLabNamespace=${sourceNamespace}#chat`);
    await expect(sourcePage.getByText("encrypted Local Device Vault is active")).toBeVisible({ timeout: 60_000 });
    await sourcePage.goto(`/?airshipLabNamespace=${sourceNamespace}#sessions`);
    const row = sourcePage.locator(".session-library-card").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await sourcePage.getByRole("button", { name: "Rename", exact: true }).click();
    await sourcePage.getByLabel("Conversation title").fill("hangar roof survey");
    await sourcePage.getByRole("button", { name: "Save rename" }).click();
    await expect(sourcePage.getByText("Renamed conversation to hangar roof survey.")).toBeVisible({ timeout: 20_000 });

    await openMovePanel(sourcePage, sourceNamespace);
    await sourcePage.getByRole("button", { name: "Select all" }).click();
    const download = sourcePage.waitForEvent("download");
    await sourcePage.getByRole("button", { name: "Write bundle file" }).click();
    const bundlePath = join(directory, "from-source.json");
    await (await download).saveAs(bundlePath);

    // ── The new device, mid-adoption ───────────────────────────────────────
    await enrollLocalDevice(targetPage);
    /*
     * Held for a moment, not forever. `durableAuthoritySettled` has a liveness
     * ceiling of eight seconds so a backend whose preconditions never assemble
     * cannot hold a person hostage — the same ceiling the chat route lives
     * with — so this delay stays well inside it and the refusal is measured
     * where a real cold boot puts it.
     */
    let released = 0;
    await targetPage.route(/local-device-keyring/u, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      released = Date.now();
      await route.continue();
    });

    await openMovePanel(targetPage, targetNamespace);
    await targetPage.locator('.work-bundle__file input[type="file"]').setInputFiles(bundlePath);
    const preview = targetPage.locator(".work-bundle__preview").first();
    // Reading the file is not writing anything, so inspection still answers.
    await expect(preview).toContainText("This bundle holds 1 conversation.", { timeout: 20_000 });
    await expect(preview).toContainText("1 will be added.");

    // The import action is closed, and says why while it is.
    const waiting = preview.getByRole("button", { name: "Waiting for this storage" });
    await expect(waiting).toBeVisible();
    await expect(waiting).toBeDisabled();
    await expect(preview).toContainText("still opening the storage its work lives in");
    await expect(preview).toContainText("refused rather than queued");
    await expect(preview).toContainText("Nothing changed");
    // Refused, not queued: nothing is promised for later and nothing was added.
    await expect(targetPage.locator(".work-bundle__preview")).not.toContainText("conversation added");

    /*
     * ── The storage opens, and the plan about the other journal goes with it ─
     *
     * Measured before this: the plan stayed on screen saying "1 will be added"
     * for the whole eight-second adoption, the button enabled itself against a
     * journal the plan had never been read against, and pressing it reported
     * "0 conversations added. 1 skipped as already present." — an outcome the
     * panel had just promised could not happen. The refusal above had already
     * named the remedy, so the remedy is what happens.
     */
    const withdrawn = targetPage.locator(".work-bundle__refused").filter({ hasText: "finished opening" });
    await expect(withdrawn).toBeVisible({ timeout: 60_000 });
    expect(released, "the refusal held until the keyring module was released").toBeGreaterThan(0);
    await expect(withdrawn).toContainText("Nothing changed and nothing was added");
    await expect(withdrawn).toContainText("choose the file again");
    // The plan it described is gone rather than sitting there being wrong.
    await expect(targetPage.locator(".work-bundle__preview")).toHaveCount(0);
    await expect(targetPage.locator(".work-bundle")).not.toContainText("will be added");
    await expect(targetPage.locator(".work-bundle")).not.toContainText("conversation added");

    // ── Choosing the file again is the remedy, and it lands ─────────────────
    await targetPage.locator('.work-bundle__file input[type="file"]').setInputFiles(bundlePath);
    const replanned = targetPage.locator(".work-bundle__preview").first();
    await expect(replanned).toContainText("This bundle holds 1 conversation.", { timeout: 20_000 });
    await expect(replanned).toContainText("1 will be added.");
    const add = replanned.getByRole("button", { name: "Add 1 conversation" });
    await expect(add).toBeEnabled({ timeout: 60_000 });
    await add.click();
    await expect(targetPage.locator(".work-bundle__preview")).toContainText("1 conversation added.", { timeout: 30_000 });

    // ── And it is still there after the adoption, and after a reload ────────
    await targetPage.waitForTimeout(5_000);
    await expect(targetPage.getByRole("button", { name: /hangar roof survey/u }).first()).toBeVisible({ timeout: 30_000 });
    await targetPage.unroute(/local-device-keyring/u);
    await targetPage.goto(`/?airshipLabNamespace=${targetNamespace}#sessions`);
    await expect(targetPage.getByRole("button", { name: /hangar roof survey/u }).first())
      .toBeVisible({ timeout: 60_000 });
  } finally {
    await source.close();
    await target.close();
  }
});
