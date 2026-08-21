import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * A file may not put this page into Full Access.
 *
 * The previous pass refused an approval mode, a model and a context policy on a
 * bundle's session *record*, and the audit that followed defeated it with the
 * product's own export button: the same pins ride as
 * `session.approval-policy-changed` and `session.model-changed` events, and
 * `migrateJournalState` replays a file's whole history through
 * `JournalBackend.append`, whose projection re-established the pin on the
 * landed record. The escalation was worse than the landing — the shell reads
 * the approval mode from whichever conversation is displayed, held or not, so
 * simply opening the imported conversation, which is exactly what the product
 * tells a person to do with one, put every human-proposed effect into Full
 * Access and wrote "Full Access" in the composer.
 *
 * This is that journey, run as a person would run it: one device chooses Full
 * Access and exports; the other imports and opens what arrived.
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

test("a bundle cannot carry Full Access, by its record or by its events", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium origin covers the real OPFS journal path.");
  test.setTimeout(300_000);
  const stamp = Date.now().toString(36);
  const laptopNamespace = `pin-laptop-${stamp}`;
  const phoneNamespace = `pin-phone-${stamp}`;
  const directory = await mkdtemp(join(tmpdir(), "airship-pin-"));

  const laptop: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const phone: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const laptopPage = await laptop.newPage();
  const phonePage = await phone.newPage();

  try {
    await enrollLocalDevice(laptopPage);
    await enrollLocalDevice(phonePage);

    // 1. The laptop makes a conversation and puts it in Full Access, with the
    //    control the product ships for it. This is the whole exploit toolkit.
    await laptopPage.goto(`/?airshipLabNamespace=${laptopNamespace}#chat`);
    await expect(laptopPage.getByText("encrypted Local Device Vault is active")).toBeVisible({ timeout: 40_000 });
    const composer = laptopPage.getByRole("combobox", { name: "Message Airship" });
    await composer.fill("pin this thread wide open");
    await laptopPage.getByRole("button", { name: "Send message" }).click();
    await expect(laptopPage.locator(".transcript")).toContainText("pin this thread wide open", { timeout: 30_000 });
    await laptopPage.locator(".composer-approval-select .menu-select-trigger").click();
    await laptopPage.getByRole("option", { name: /Full Access/u }).click();
    await expect(laptopPage.locator(".runtime-line__text").first())
      .toContainText("Approval policy changed to Full Access for this conversation.", { timeout: 20_000 });
    await expect(laptopPage.locator(".composer-approval-select .menu-select-value")).toContainText(/Full Access/u);

    // 2. The export button writes the file. The record carries no pin — the
    //    previous pass saw to that — and the events carry the whole history.
    await openMovePanel(laptopPage, laptopNamespace);
    await laptopPage.getByRole("button", { name: "Select all" }).click();
    const download = laptopPage.waitForEvent("download");
    await laptopPage.getByRole("button", { name: "Write bundle file" }).click();
    const file = join(directory, "full-access.json");
    await (await download).saveAs(file);

    // 3. The phone takes it in. Its own standing decision is Ask First.
    await phonePage.goto(`/?airshipLabNamespace=${phoneNamespace}#chat`);
    await expect(phonePage.getByText("encrypted Local Device Vault is active")).toBeVisible({ timeout: 40_000 });
    await expect(phonePage.locator(".composer-approval-select .menu-select-value")).toContainText(/Ask First/u);
    await openMovePanel(phonePage, phoneNamespace);
    await phonePage.locator('.work-bundle__file input[type="file"]').setInputFiles(file);
    const preview = phonePage.locator(".work-bundle__preview").first();
    await expect(preview).toContainText("1 will be added.", { timeout: 20_000 });
    await preview.getByRole("button", { name: "Add 1 conversation" }).click();
    await expect(phonePage.locator(".work-bundle__preview")).toContainText("1 conversation added.", { timeout: 30_000 });

    // 4. And the person does what the product tells them to do with an import:
    //    they open it at its own address and read it. That used to be the
    //    escalation — reading it was enough to re-mode the page.
    const bundle = JSON.parse(await readFile(file, "utf8")) as { conversations: { session: { id: string } }[] };
    const importedId = bundle.conversations[0]!.session.id;
    await phonePage.goto(`/?airshipLabNamespace=${phoneNamespace}#chat/${importedId}`);
    // The conversation on screen is the imported one: the composer band carries
    // the refusal only a record stamped as having arrived in a file produces,
    // and its one remedy.
    await expect(phonePage.locator(".composer-notice")).toContainText("arrived in a bundle file", { timeout: 30_000 });
    await expect(phonePage.getByRole("button", { name: "Fork to continue" })).toBeVisible();
    expect(phonePage.url()).toContain(`#chat/${importedId}`);

    // And the mode the page is in is this device's own standing decision, not
    // the one the file's events would have projected onto the landed record.
    await expect(phonePage.locator(".composer-approval-select .menu-select-value")).toContainText(/Ask First/u);
    await expect(phonePage.locator(".composer-approval-select .menu-select-value")).not.toContainText(/Full Access/u);
  } finally {
    await laptop.close();
    await phone.close();
  }
});
