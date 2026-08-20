import { expect, test } from "@playwright/test";
import { completeLocalDeviceCeremony } from "./support/vault-ceremony";
import { setProfilePresentationDensity } from "./support/density";

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
  /*
   * Wait for the finalized local run record, not a cheaper nearby signal. The
   * composer clears at SEND and the assistant card appears with the first token;
   * reloading on either signal strands a turn with no durable terminal event.
   * The raw completion footer is instrumented-only now. At Balanced, Run details
   * is the neutral per-turn trace that arrives with the finalized receipt.
   */
  const run = latestRunDetails(page);
  await expect(run).toBeVisible({ timeout: 40_000 });
  await expect(run).toHaveText(/^Run · .+ · [0-9a-f]{8}$/u);
}

function latestRunDetails(page: import("@playwright/test").Page) {
  return page.locator('[data-transcript-card][data-message-role="assistant"]').last()
    .getByRole("button", { name: /^Run details\./u });
}

function latestRunDetailsPanel(page: import("@playwright/test").Page) {
  return page.locator('[data-transcript-card][data-message-role="assistant"]').last()
    .getByRole("group", { name: "Run details" });
}

test.describe("a person who comes back", () => {
  test("is told what was not kept, with a count, a time and the remedy", async ({ page }, testInfo) => {
    const namespace = `resume-report-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    await usePageMemory(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    /* Finalized Run details retire at the house density. This journey fences
       on that local record, so the run starts one rung up where it exists. */
    await setProfilePresentationDensity(page, "Balanced");
    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
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
    /*
     * The claims, not the phrasing. This pinned "never written down"; the copy
     * now says the same thing better — what was held, where it went, and what
     * Airship kept in order to be able to tell you at all. A test that fails
     * when copy improves teaches people not to improve copy.
     */
    await expect(report).toContainText(/1 conversation/u);
    await expect(report).toContainText(/page memory/u);
    await expect(report).toContainText(/no title, no message, no digest/u);

    // The remedy is attached to the report, not three levels down a rail.
    await report.getByRole("button", { name: "Keep future conversations" }).click();
    await expect(page).toHaveURL(/#vault$/u);
  });

  test("sees nothing of the kind on a first-ever visit", async ({ page }, testInfo) => {
    const namespace = `resume-first-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    await usePageMemory(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator(REPORT)).toHaveCount(0);
    await expect(page.locator(".composer-notice").filter({ hasText: LOSS_NOTICE })).toHaveCount(0);
  });

  test("keeps the report until it is dismissed, and then for good", async ({ page }, testInfo) => {
    const namespace = `resume-dismiss-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    await usePageMemory(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await setProfilePresentationDensity(page, "Balanced");
    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
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
   * The transcript is asserted here, and the exemption that used to stand in
   * this place is gone.
   *
   * It said the transcript belonged to the Vault suites "deliberately", because
   * a turn sent in the same browser session as the Vault ceremony had been seen
   * to journal only three events. A test that knowingly declines to assert the
   * durable transcript is not a durability test: the suite could be green while
   * Airship lost the exact work a person believes the Vault is protecting.
   *
   * Re-measured before removing it — ten consecutive cold runs of this exact
   * lifecycle (ceremony, wait for the authority, one turn, reload) survived
   * 10/10, every one carrying 8 journal events and an identical journal head
   * across the reload. The flake did not reproduce at this HEAD. So the claim
   * is now made in full, and if the adoption transaction regresses, this is
   * where it will be caught rather than where it was excused.
   */
  test("keeps the conversation, address, draft and local run trace across a reload", async ({ page }, testInfo) => {
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
    await completeLocalDeviceCeremony(page);

    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
    // Work started before the Vault is adopted is migrated into it *and* moved
    // to a fresh pinned session, which is a different journey from this one.
    // Wait for the authority the person thinks they already have.
    await expect(page.locator("header .runtime-line__text").filter({ hasText: /Encrypted Local Device vault active/u }))
      .toBeVisible({ timeout: 40_000 });
    const prompt = "Draft the Q3 pricing memo intro paragraph.";
    await setProfilePresentationDensity(page, "Balanced");
    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
    await sendOneTurn(page, prompt);
    // Anchored on the role, not on an index: an empty conversation renders an
    // assistant-shaped intro card first, so `.message` nth(1) is the prompt
    // before a reload and the reply after one.
    const answer = (await page.locator(".message.assistant").last().innerText()).trim();
    expect(answer.length).toBeGreaterThan(0);
    const title = (await page.locator(".session-bar__title").innerText()).trim();
    const runName = await latestRunDetails(page).getAttribute("aria-label");
    expect(runName).toMatch(/^Run details\. Provider .+\. Run urn:receipt:/u);
    await latestRunDetails(page).click();
    const runPanel = latestRunDetailsPanel(page);
    await expect(runPanel.locator('[data-field="origin"]')).toContainText("Local run record");
    const receiptId = await runPanel.locator('[data-field="receipt-id"] code').innerText();
    expect(receiptId).toMatch(/^urn:receipt:/u);
    await runPanel.getByRole("button", { name: "Done" }).click();
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
    // And the conversation itself: the prompt, the reply, the name it was given,
    // and the exact neutral run record that came back with it. Receipt identity
    // distinguishes restored trace metadata from a freshly generated answer.
    await expect(page.locator(".message.user").filter({ hasText: prompt })).toBeVisible({ timeout: 30_000 });
    // Not string-equality: `.message.assistant` includes its own interface text;
    // the stable run record below carries the trace identity.
    await expect(page.locator(".message.assistant").last()).not.toBeEmpty({ timeout: 30_000 });
    expect((await page.locator(".session-bar__title").innerText()).trim()).toBe(title);
    await expect(latestRunDetails(page)).toHaveAttribute("aria-label", runName!);
    await latestRunDetails(page).click();
    await expect(latestRunDetailsPanel(page).locator('[data-field="receipt-id"] code')).toHaveText(receiptId);
    await expect(latestRunDetailsPanel(page).locator('[data-field="origin"]')).toContainText("Local run record");
    // And nothing on screen mourns a conversation that is on screen.
    await expect(page.locator(".composer-notice").filter({ hasText: LOSS_NOTICE })).toHaveCount(0);
    await expect(page.locator(REPORT)).toHaveCount(0);
  });
});
