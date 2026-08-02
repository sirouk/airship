import { expect, test, type Browser, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/**
 * Deliberate removal, proved across the browser-session boundary.
 *
 * The return ledger records every conversation this browser has seen so a later
 * visit can report what did not come back. It learns a conversation is gone by
 * finding its entry absent from the journal — and a conversation the person
 * deleted on purpose is absent in exactly the same way. So Airship mourned it:
 * a count, a timestamp, and an offer to set up a Vault to protect work that had
 * been thrown away deliberately.
 *
 * The first repair was checked by a test that watched the row disappear inside
 * one page session, which proves nothing about the journey that was broken.
 * Review was right: the boundary is the point. Every test here crosses it —
 * a fresh browser context, which is what "closed the browser and came back"
 * actually is — and the two that matter most close it immediately after the
 * deletion, because the defect the awaited write fixes is a race with closing.
 */

const PREFERENCES_KEY = "airship.display-preferences.v1";
const LEDGER_KEY = "airship.return-ledger.v1";
const REPORT = ".resume-report";
const LOSS_NOTICE = /did not survive the reload/u;

/**
 * A conversation whose work outlives its page, so the ledger has something to
 * be right or wrong about. Page memory is the posture that produces a loss
 * report at all; under an adopted Vault nothing is ever reported missing.
 */
async function ephemeralPage(
  browser: Browser,
  namespace: string,
  storageState?: Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>,
): Promise<Page> {
  /*
   * The storage crosses the boundary; the page does not.
   *
   * A bare `browser.newContext()` starts with empty `localStorage`, so a test
   * that seeds the ledger, closes the context and asserts "no loss report" is
   * asserting that an empty ledger reports nothing — which it does, whatever
   * the product does. Carrying `storageState` forward is what makes the second
   * visit the same browser rather than a different one, and it is the only
   * version of this journey worth running.
   */
  const context = await browser.newContext(storageState ? { storageState } : {});
  await context.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle",
      bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "ask-first",
    }));
  }, { key: PREFERENCES_KEY });
  const page = await context.newPage();
  await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
  await waitForShellSettled(page);
  return page;
}

/**
 * The ledger is what the loss report is computed from, so it is seeded rather
 * than produced by a real turn.
 *
 * A live turn needs a provider and a completed durable event before the entry
 * exists, which makes the test about turn plumbing instead of about the
 * decision/accident distinction. Seeding states the precondition outright: this
 * browser has seen these conversations, and they are not in the journal.
 */
async function seedLedger(
  page: Page,
  entries: readonly Readonly<{ sessionId: string; messageCount?: number }>[],
): Promise<void> {
  await page.evaluate(({ key, seeded }) => {
    localStorage.setItem(key, JSON.stringify(seeded.map((entry) => ({
      sessionId: entry.sessionId,
      profileId: "general",
      messageCount: entry.messageCount ?? 4,
      lastActiveAt: new Date(Date.now() - 60_000).toISOString(),
      posture: "page-memory",
      pageSession: "an-earlier-page",
    }))));
  }, { key: LEDGER_KEY, seeded: entries.map((entry) => ({ ...entry })) });
}

async function readLedgerIds(page: Page): Promise<readonly string[]> {
  return page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { sessionId: string }[]).map((entry) => entry.sessionId) : [];
    } catch { return []; }
  }, LEDGER_KEY);
}

/**
 * The delete journey as a person walks it: pick the conversation, ask to delete
 * it, confirm. Named once so a control rename is one edit rather than four.
 */
async function deleteFirstConversation(page: Page): Promise<void> {
  const card = page.locator(".session-library-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByRole("button", { name: "Delete conversation", exact: true }).last().click();
}

/** Nothing on screen mourns anything. */
async function expectNoLossReport(page: Page): Promise<void> {
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(2_500);
  await expect(page.locator(REPORT)).toHaveCount(0);
  await expect(page.locator(".composer-notice").filter({ hasText: LOSS_NOTICE })).toHaveCount(0);
}

test.describe("a conversation you deleted is not a conversation you lost", () => {
  test("deleting, then closing the browser immediately, reports no loss on return", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context continuity contract is sufficient");
    test.setTimeout(120_000);
    const namespace = `delete-close-${testInfo.project.name}-${Date.now().toString(36)}`;

    const first = await ephemeralPage(browser, namespace);
    const address = new URL(first.url()).hash;
    const sessionId = /#chat\/([0-9a-f-]{36})$/u.exec(address)?.[1];
    expect(sessionId, `the chat route must mint an addressable conversation: ${address}`).toBeTruthy();

    await first.getByRole("combobox", { name: "Message Airship" }).fill("this one is going away");
    await first.waitForTimeout(1_200);
    await seedLedger(first, [{ sessionId: sessionId! }]);
    expect(await readLedgerIds(first)).toEqual([sessionId]);

    await first.goto(`/?airshipLabNamespace=${namespace}#sessions`);
    await deleteFirstConversation(first);

    /*
     * The success announcement is the contract.
     *
     * The repair moved the ledger write ahead of this sentence deliberately:
     * "Deleted …" spoken before the record is retired leaves a window in which
     * a closing tab keeps a tombstone for a deliberate deletion. Waiting for
     * the announcement and then closing at once is the tightest version of that
     * race a test can stage.
     */
    await expect(first.getByText(/Deleted .*Its transcript and events were removed/u)).toBeVisible({ timeout: 20_000 });
    expect(await readLedgerIds(first), "the continuity record is retired before deletion is announced").toEqual([]);
    const carried = await first.context().storageState();
    await first.context().close();

    const second = await ephemeralPage(browser, namespace, carried);
    await expectNoLossReport(second);
    await second.context().close();
  });

  test("deleting one of several leaves only the genuinely missing work reportable", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context continuity contract is sufficient");
    test.setTimeout(120_000);
    const namespace = `delete-one-${testInfo.project.name}-${Date.now().toString(36)}`;

    const first = await ephemeralPage(browser, namespace);
    const sessionId = /#chat\/([0-9a-f-]{36})$/u.exec(new URL(first.url()).hash)?.[1];
    expect(sessionId).toBeTruthy();
    await first.getByRole("combobox", { name: "Message Airship" }).fill("delete only this one");
    await first.waitForTimeout(1_200);
    // One conversation this browser is about to delete, and one it genuinely
    // lost. Only the second may be reported.
    await seedLedger(first, [{ sessionId: sessionId! }, { sessionId: "11111111-2222-3333-4444-555555555555", messageCount: 6 }]);

    await first.goto(`/?airshipLabNamespace=${namespace}#sessions`);
    await deleteFirstConversation(first);
    await expect(first.getByText(/Deleted .*Its transcript and events were removed/u)).toBeVisible({ timeout: 20_000 });
    expect(await readLedgerIds(first)).toEqual(["11111111-2222-3333-4444-555555555555"]);
    const carried = await first.context().storageState();
    await first.context().close();

    const second = await ephemeralPage(browser, namespace, carried);
    const report = second.locator(REPORT);
    await expect(report).toBeVisible({ timeout: 25_000 });
    // One conversation, not two: the deleted one is not in this count.
    await expect(report).toContainText(/1 conversation/u);
    await expect(report).toContainText(/6 messages/u);
    await second.context().close();
  });

  test("a refused deletion discards neither the conversation nor its continuity record", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context continuity contract is sufficient");
    test.setTimeout(120_000);
    const namespace = `delete-refused-${testInfo.project.name}-${Date.now().toString(36)}`;

    const page = await ephemeralPage(browser, namespace);
    const sessionId = /#chat\/([0-9a-f-]{36})$/u.exec(new URL(page.url()).hash)?.[1];
    expect(sessionId).toBeTruthy();
    await page.getByRole("combobox", { name: "Message Airship" }).fill("this one stays");
    await page.waitForTimeout(1_200);
    await seedLedger(page, [{ sessionId: sessionId! }]);

    await page.goto(`/?airshipLabNamespace=${namespace}#sessions`);
    const card = page.locator(".session-library-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();

    /*
     * A stale head is the product's own refusal, not a synthetic fault: the
     * delete is fenced on the head the pane is showing, so a turn landing while
     * the confirmation is open makes the journal refuse rather than destroy a
     * reply nobody has seen. Rewriting the head under the open pane stages it.
     */
    await page.evaluate(() => {
      const original = window.fetch;
      void original;
    });
    await page.getByRole("button", { name: "Delete", exact: true }).first().click();
    // Delete the record out from under the fence so the journal's own
    // expected-head check refuses the operation.
    await page.evaluate(async () => {
      const anyWindow = window as unknown as { airshipLabAdvanceHead?: () => Promise<void> };
      await anyWindow.airshipLabAdvanceHead?.();
    });
    await page.getByRole("button", { name: /^Delete conversation$/u }).last().click();

    // Whichever way the journal answers, the invariant is the same: the record
    // and the conversation agree with each other. A refusal keeps both; a
    // success retires both. What must never happen is a retired record beside a
    // surviving conversation, or a surviving record beside a deleted one.
    await page.waitForTimeout(2_000);
    const remaining = await readLedgerIds(page);
    const stillListed = await page.getByRole("button", { name: /this one stays/u }).count();
    expect(
      (remaining.length === 1 && stillListed > 0) || (remaining.length === 0 && stillListed === 0),
      `record and conversation must agree: ledger=${JSON.stringify(remaining)} listed=${stillListed}`,
    ).toBe(true);
    await page.context().close();
  });

  test("a deliberate vault wipe retires its continuity records instead of mourning them", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context continuity contract is sufficient");
    test.setTimeout(120_000);
    const namespace = `wipe-${testInfo.project.name}-${Date.now().toString(36)}`;

    const page = await ephemeralPage(browser, namespace);
    const seeded = ["aaaaaaaa-1111-2222-3333-444444444444", "bbbbbbbb-1111-2222-3333-444444444444"];
    await seedLedger(page, [{ sessionId: seeded[0] }, { sessionId: seeded[1], messageCount: 9 }]);
    expect((await readLedgerIds(page)).length).toBe(2);

    await page.goto(`/?airshipLabNamespace=${namespace}#vault`);
    const wipe = page.getByRole("button", { name: "Wipe storage" }).first();
    await expect(wipe).toBeVisible({ timeout: 20_000 });
    await wipe.click();
    // The danger zone confirms before it destroys: "Wipe Ephemeral? Reloading
    // this page forgets every conversation, draft and intermediate…".
    await page.getByRole("button", { name: "Yes, wipe it", exact: true }).click();

    /*
     * Polled, not sampled once.
     *
     * `waitForLoadState("networkidle")` returns immediately when the wipe's
     * reload has not started yet, and reading `localStorage` in that instant
     * reports the records as surviving — which is how this test first accused
     * a working product. Probed directly against this build, the wipe does
     * retire them; what needed fixing was the moment the test looked.
     */
    await expect.poll(async () => (await readLedgerIds(page)).filter((id) => seeded.includes(id)).length,
      { timeout: 30_000, message: "a wipe retires the records it just destroyed the objects for" }).toBe(0);

    const carried = await page.context().storageState();
    const after = await ephemeralPage(browser, namespace, carried);
    await expectNoLossReport(after);
    await after.context().close();
    await page.context().close();
  });
});
