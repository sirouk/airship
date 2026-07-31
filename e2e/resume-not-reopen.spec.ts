import { expect, test } from "@playwright/test";

/**
 * Airship reopened rather than resumed, and said nothing either way.
 *
 * Two measured failures, one cause. A person who worked in page memory closed
 * the browser and came back to a screen byte-identical to a first-ever visit —
 * no notice, no tombstone, "All conversations" reporting the empty conversation
 * that boot had just minted. And a person who had paid for an encrypted Vault
 * reloaded onto their own conversation's URL and was told "That conversation
 * existed only in page memory and did not survive the reload" while the topbar
 * beside it read "audited session resumed", because the address was resolved
 * against a page-memory journal a second before the Vault's arrived.
 *
 * `first-run-truth.spec.ts` owns the other end of the same rule: a first visit
 * must claim nothing, and a genuinely dead address must still be reported.
 * These are the middle cases it leaves open.
 */

const PREFERENCES_KEY = "airship.display-preferences.v1";
const LOSS_NOTICE = /did not survive the reload/u;
const REPORT = ".resume-report";

async function usePageMemory(page: import("@playwright/test").Page): Promise<void> {
  // Ephemeral is a decision the product supports, and it makes the loss under
  // test the documented behaviour of a chosen posture rather than a fault.
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  }, { key: PREFERENCES_KEY });
}

async function sendOneTurn(page: import("@playwright/test").Page, prompt: string): Promise<void> {
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message.user").filter({ hasText: prompt })).toBeVisible({ timeout: 20_000 });
  // The answer, not just the prompt: a turn is durable when it has ended, and
  // reloading through the middle of one measures a different thing.
  await expect(page.locator(".message").nth(1)).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveValue("", { timeout: 20_000 });
}

test.describe("a person who comes back", () => {
  test("is told what was not kept, with a count, a time and the remedy", async ({ page }, testInfo) => {
    const namespace = `resume-report-${testInfo.project.name}-${Date.now().toString(36)}`;
    await usePageMemory(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await sendOneTurn(page, "Draft the Q3 pricing memo intro paragraph.");

    // A reload is the cheapest real page-session boundary: the journal lived in
    // page memory and does not cross it, exactly as a browser restart.
    await page.reload();

    const report = page.locator(REPORT);
    await expect(report).toBeVisible({ timeout: 25_000 });
    await expect(report).toContainText(/1 conversation · 2 messages · last active /u);
    await expect(report).toContainText(/page memory/u);
    // The count and the clock are all Airship kept, and it says so rather than
    // leaving the reader to assume it is withholding the conversation.
    await expect(report).toContainText(/never written down/u);

    // The remedy is attached to the report, not three levels down a rail.
    await report.getByRole("button", { name: "Keep future conversations" }).click();
    await expect(page).toHaveURL(/#vault$/u);
  });

  test("sees nothing of the kind on a first-ever visit", async ({ page }, testInfo) => {
    const namespace = `resume-first-${testInfo.project.name}-${Date.now().toString(36)}`;
    await usePageMemory(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator(REPORT)).toHaveCount(0);
    await expect(page.locator(".composer-notice").filter({ hasText: LOSS_NOTICE })).toHaveCount(0);
  });

  test("keeps the report until it is dismissed, and then for good", async ({ page }, testInfo) => {
    const namespace = `resume-dismiss-${testInfo.project.name}-${Date.now().toString(36)}`;
    await usePageMemory(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await sendOneTurn(page, "Something worth keeping.");
    await page.reload();
    await expect(page.locator(REPORT)).toBeVisible({ timeout: 25_000 });

    // Unread is not the same as acknowledged: a second return still reports it.
    await page.reload();
    const report = page.locator(REPORT);
    await expect(report).toBeVisible({ timeout: 25_000 });
    await report.getByRole("button", { name: "Dismiss the report of work that was not kept" }).click();
    await expect(report).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator(REPORT)).toHaveCount(0);
  });
});

test.describe("a person whose Vault held the conversation", () => {
  /*
   * The transcript itself is asserted by the Vault suites, not here, and
   * deliberately: measured on this build *and* on the pre-change build, a turn
   * sent in the same browser session that ran the Vault ceremony journals no
   * durable events at all — three consecutive baseline runs reported
   * "3 events" for a completed turn, and one reported 8. That flake belongs to
   * the adoption transaction. What this test owns is the claim Airship makes
   * about the address and the draft on the far side of a reload, which held on
   * every run of both builds.
   */
  test("keeps the address, the draft, and its mouth shut about a conversation it still has", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "One Chromium origin owns the device-Vault ceremony; the mobile project covers presentation.",
    );
    // The ceremony, a turn, and a Vault adoption on the far side of a reload.
    test.setTimeout(150_000);
    const namespace = `resume-vault-${Date.now().toString(36)}`;
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

    await page.goto(`/?airshipLabNamespace=${namespace}#vault`);
    const setup = page.locator(".local-device-vault");
    await setup.getByRole("button", { name: "Create new" }).click();
    await setup.getByRole("checkbox", { name: /I saved this recovery key outside Airship/u }).click();
    await setup.getByRole("button", { name: "Create encrypted Vault" }).click();
    await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
    // Work started before the Vault is adopted is migrated into it *and* moved
    // to a fresh pinned session, which is a different journey from this one.
    // Wait for the authority the person thinks they already have.
    await expect(page.locator("header .runtime-line__text").filter({ hasText: /Encrypted Local Device vault active/u }))
      .toBeVisible({ timeout: 40_000 });
    await sendOneTurn(page, "Draft the Q3 pricing memo intro paragraph.");
    const composer = page.getByRole("combobox", { name: "Message Airship" });
    const draft = "and one more thing I still need to check before Friday";
    await composer.fill(draft);
    // Past both the tab-storage and the encrypted-workspace draft debounces.
    await page.waitForTimeout(1_500);
    const address = new URL(page.url()).hash;
    expect(address).toMatch(/^#chat\/[0-9a-f-]{36}$/u);

    await page.reload();
    await expect(page.locator("header .runtime-line__text").filter({ hasText: /Encrypted Local Device vault active/u }))
      .toBeVisible({ timeout: 40_000 });

    // The address the person is standing on is the conversation they get back:
    // the bookmark, the restored tab, the link they sent themselves.
    expect(new URL(page.url()).hash).toBe(address);
    // The half-finished sentence is the person's, not the page's.
    await expect(composer).toHaveValue(draft, { timeout: 20_000 });
    // And nothing on screen mourns a conversation that is on screen.
    await expect(page.locator(".composer-notice").filter({ hasText: LOSS_NOTICE })).toHaveCount(0);
    await expect(page.locator(REPORT)).toHaveCount(0);
  });
});
