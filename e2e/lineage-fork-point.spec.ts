import { expect, test } from "@playwright/test";

/*
 * The two halves of a fork point, on the two surfaces that state it.
 *
 * Upward, a branch has always said "Forked from X at head 12". Downward, the
 * source's "Alternates (N)" list named titles and branch times only — so three
 * retries of one turn and three branches of three different turns rendered
 * identically, on the one screen a reader opens to compare them. The sequence
 * comes from each branch's own `lineage.sourceHeadSequence`, the same manifest
 * commitment the upward line reads, so the two directions cannot disagree.
 */
test("the source conversation names the fork point of every alternate", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop lineage legibility contract");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const sourceId = page.url().split("#chat/")[1]!;

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("Explain fork points in one sentence.");
  await page.getByRole("button", { name: "Send message" }).click();
  const answer = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  await answer.hover();
  await answer.getByRole("button", { name: "Fork from here" }).click();
  await expect(page.locator(".composer-notice")).toContainText("True fork created at the audited boundary after this answer");
  await expect.poll(() => page.url()).not.toContain(sourceId);

  await page.goto("/#sessions");
  const library = page.getByRole("region", { name: "All conversations" });
  await expect(library).toBeVisible();
  // The *source*, not the branch: the downward direction is the one that had
  // no fork point.
  await page.locator(`.session-library-row[data-session-id="${sourceId}"] .session-library-card`).click();

  const alternates = page.locator(".session-library-alternates");
  await expect(alternates).toBeVisible();
  await expect(alternates.locator(".session-library-alternates__heading")).toContainText("Alternates (1)");
  const entry = alternates.locator("li").first();
  await expect(entry).toContainText(/branched at head \d+/u);
  await expect(entry).not.toContainText("fork point unrecorded");
  // A screen reader navigating this list by link name never reaches the
  // caption beside the button, so the fork point travels in the name too.
  await expect(entry.getByRole("button", { name: /Open the branch .*, branched at head \d+/u })).toBeVisible();

  // The upward line still reads from the same commitment.
  await entry.getByRole("button").click();
  await expect(page.locator(".session-library-lineage-line")).toContainText(/at head \d+ · source untouched/u);
});

/*
 * TRM-06: the shell has a row on the surface that audits this journal.
 *
 * Terminal lineage lived in the manager's own 64-record ring buffer and
 * nowhere else, so Proof could not distinguish a session where no shell ran
 * from one whose shell work was never recorded. A count of zero is a fact; the
 * absence was not. This journey does not start a WebContainer — that is the
 * live master suite's job — it asserts the row exists and reads the audit.
 *
 * The row now stands in the recorded-work ledger beside the verdict rather than
 * inside the journal disclosure: a reader asking what was recorded was reading
 * a panel that collapses itself whenever the structure passes.
 */
test("session journal integrity states how many shell records it audited", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop proof surface contract");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  // A turn, so the session being audited has a journal to audit rather than a
  // bare creation event.
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Record something worth auditing.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-transcript-card][data-message-role="assistant"]').last()).toBeVisible();

  await page.goto("/#proof");
  const ledger = page.getByLabel("Work recorded in this session’s journal");
  await expect(ledger).toBeVisible();
  await expect(ledger).toContainText("Shell records");
  await expect(ledger.locator("div").filter({ hasText: "Shell records" }).locator("dd")).toHaveText(/^\d+$/u);
  // The journal panel keeps the facts about the check itself.
  const journal = page.locator(".proof-journal");
  const summary = journal.locator("summary.proof-journal__row");
  if (await journal.evaluate((element) => !(element as HTMLDetailsElement).open)) await summary.click();
  await expect(journal.locator(".audit-commitment")).toContainText("Journal events");
});
