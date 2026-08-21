import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

/**
 * Two devices, two bundles, both directions, nothing lost.
 *
 * Until this landed, `downloadBytes` had exactly two callers — one workspace
 * file and the whole encrypted Vault — so a person could not get a conversation
 * out of Airship at all, and the one thing that could move a whole journal
 * (`restore`) is `replaceAll`: carrying a phone's work back to a laptop
 * destroyed the laptop's newer work.
 *
 * The journey below is the refutation, run as a person would run it. Two
 * browser contexts are two devices: separate storage, separate Local Device
 * Vault enrolments, separate journals. Work is made on both. A readable bundle
 * moves laptop → phone, then a second bundle moves phone → laptop, and at the
 * end each device holds both conversations. The bundle files themselves are
 * read off disk and compared byte for byte on session id, every event digest
 * and the digest head, which is what "the digests survived" has to mean.
 */

const PARTITION = "airship-workspace-v1";

type Bundle = {
  conversations: {
    session: { id: string; title: string; headSequence: number; headDigest: string };
    events: { eventId: string; sequence: number; digest: string; previousDigest: string }[];
  }[];
  memory: unknown;
};

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

/**
 * One conversation with a real completed turn and a durable rename.
 *
 * The turn is what gives the chain turn records and a receipt, so the audit
 * this journey checks after the import has something to audit. The rename is a
 * `session.renamed` append with words a person chose, which is what makes the
 * "readable means readable" check on the file honest. Both are real journal
 * appends, hashed like every other event.
 */
async function makeWork(page: Page, namespace: string, title: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
  await expect(page.getByText("encrypted Local Device Vault is active")).toBeVisible({ timeout: 40_000 });
  // The turn footer this journey fences on retires at minimal density.
  await setProfilePresentationDensity(page, "Instrumented");
  await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
  await page.getByRole("combobox", { name: "Message Airship" }).fill(title);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".part-footer").filter({ hasText: /Turn completed/u }).last())
    .toBeVisible({ timeout: 60_000 });

  await page.goto(`/?airshipLabNamespace=${namespace}#sessions`);
  const row = page.locator(".session-library-card").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Conversation title").fill(title);
  await page.getByRole("button", { name: "Save rename" }).click();
  await expect(page.getByText(`Renamed conversation to ${title}.`)).toBeVisible({ timeout: 20_000 });
}

async function openMovePanel(page: Page, namespace: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#sessions`);
  const toggle = page.getByRole("button", { name: "Move work" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  // Navigating to the address the page is already at is a same-document move,
  // so the panel may already be open from an earlier step. The control states
  // its own state; clicking it blind would close what this is asking to open.
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 20_000 });
}

async function writeBundle(page: Page, directory: string, name: string): Promise<string> {
  await page.getByRole("button", { name: "Select all" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Write bundle file" }).click();
  const file = await download;
  const path = join(directory, name);
  await file.saveAs(path);
  return path;
}

async function readBundle(path: string): Promise<Bundle> {
  return JSON.parse(await readFile(path, "utf8")) as Bundle;
}

test("work moves laptop → phone → laptop as a file, and neither device loses anything", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium origin covers the real OPFS journal path.");
  test.setTimeout(300_000);
  const stamp = Date.now().toString(36);
  const laptopNamespace = `bundle-laptop-${stamp}`;
  const phoneNamespace = `bundle-phone-${stamp}`;
  const directory = await mkdtemp(join(tmpdir(), "airship-bundle-"));

  const laptop: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const phone: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const laptopPage = await laptop.newPage();
  const phonePage = await phone.newPage();

  try {
    await enrollLocalDevice(laptopPage);
    await enrollLocalDevice(phonePage);
    await makeWork(laptopPage, laptopNamespace, "survey the hangar roof");
    await makeWork(phonePage, phoneNamespace, "check the ballast tanks");

    // 1. Laptop -> file.
    await openMovePanel(laptopPage, laptopNamespace);
    const fromLaptop = await writeBundle(laptopPage, directory, "from-laptop.json");
    const laptopBundle = await readBundle(fromLaptop);
    expect(laptopBundle.conversations).toHaveLength(1);
    expect(laptopBundle.memory).toBeNull();
    // Readable really means readable: the words a person chose are in the file,
    // in the clear, with no Airship codec between them and `JSON.parse`.
    expect(laptopBundle.conversations[0]!.session.title).toBe("survey the hangar roof");
    expect(JSON.stringify(laptopBundle.conversations[0]!.events)).toContain("survey the hangar roof");
    expect(laptopBundle.conversations[0]!.events.at(-1)!.digest)
      .toBe(laptopBundle.conversations[0]!.session.headDigest);
    // Provenance travels because the events do: the completed turn's receipt
    // and its response digest are in the file exactly as the journal wrote them.
    expect(JSON.stringify(laptopBundle.conversations[0]!.events)).toContain("receiptId");
    expect(JSON.stringify(laptopBundle.conversations[0]!.events)).toContain("responseDigest");

    // 2. File -> phone, which already holds work of its own.
    await openMovePanel(phonePage, phoneNamespace);
    await phonePage.locator('.work-bundle__file input[type="file"]').setInputFiles(fromLaptop);
    const preview = phonePage.locator(".work-bundle__preview").first();
    await expect(preview).toContainText("This bundle holds 1 conversation.", { timeout: 20_000 });
    await expect(preview).toContainText("1 will be added.");
    // What it will NOT touch is stated before anything is written.
    await expect(preview).toContainText("Not touched: 1 conversation already here");
    await preview.getByRole("button", { name: "Add 1 conversation" }).click();
    await expect(phonePage.locator(".work-bundle__preview")).toContainText("1 conversation added.", { timeout: 30_000 });

    // The phone now holds both, and the imported one still audits.
    await phonePage.goto(`/?airshipLabNamespace=${phoneNamespace}#sessions`);
    await expect(phonePage.getByRole("button", { name: /survey the hangar roof/u }).first())
      .toBeVisible({ timeout: 30_000 });
    await expect(phonePage.getByRole("button", { name: /check the ballast tanks/u }).first()).toBeVisible();
    await phonePage.getByRole("button", { name: /survey the hangar roof/u }).first().click();
    // The audit the product runs on its own conversations, on the imported
    // copy, in a journal that never saw the turn happen.
    await expect(phonePage.getByText("Structure passed").first()).toBeVisible({ timeout: 20_000 });
    await expect(phonePage.locator(".session-library-detail")).toContainText(/(\d+) of \1 events inspected/u);

    // 3. Phone -> file -> laptop. This is the direction `restore` destroys.
    await openMovePanel(phonePage, phoneNamespace);
    const fromPhone = await writeBundle(phonePage, directory, "from-phone.json");
    const phoneBundle = await readBundle(fromPhone);
    expect(phoneBundle.conversations).toHaveLength(2);

    // The conversation that made the round trip is byte-identical on both
    // sides: same id, same event digests, same head.
    const there = laptopBundle.conversations[0]!;
    const back = phoneBundle.conversations.find((entry) => entry.session.id === there.session.id);
    expect(back, "the exported conversation kept its session id").toBeTruthy();
    expect(back!.session.headDigest).toBe(there.session.headDigest);
    expect(back!.session.headSequence).toBe(there.session.headSequence);
    expect(back!.events.map((event) => event.digest)).toEqual(there.events.map((event) => event.digest));
    expect(back!.events.map((event) => event.eventId)).toEqual(there.events.map((event) => event.eventId));
    expect(JSON.stringify(back!.events)).toBe(JSON.stringify(there.events));

    await openMovePanel(laptopPage, laptopNamespace);
    await laptopPage.locator('.work-bundle__file input[type="file"]').setInputFiles(fromPhone);
    const laptopPreview = laptopPage.locator(".work-bundle__preview").first();
    await expect(laptopPreview).toContainText("This bundle holds 2 conversations.", { timeout: 20_000 });
    await expect(laptopPreview).toContainText("1 will be added.");
    // The one that came from here is recognised rather than rewritten.
    await expect(laptopPreview).toContainText("1 is already here and will be skipped.");
    await laptopPreview.getByRole("button", { name: "Add 1 conversation" }).click();
    await expect(laptopPage.locator(".work-bundle__preview"))
      .toContainText("1 conversation added. 1 skipped as already present.", { timeout: 30_000 });

    // 4. Nothing was lost on either device.
    await laptopPage.goto(`/?airshipLabNamespace=${laptopNamespace}#sessions`);
    await expect(laptopPage.getByRole("button", { name: /survey the hangar roof/u }).first())
      .toBeVisible({ timeout: 30_000 });
    await expect(laptopPage.getByRole("button", { name: /check the ballast tanks/u }).first()).toBeVisible();
  } finally {
    await laptop.close();
    await phone.close();
  }
});
