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
  const fork = answer.getByRole("button", { name: "Fork from here" });
  /*
   * The actions toolbar arms `pointer-events` only under a live hover, and
   * a hover anchored while the answer is still streaming dies with it: turn
   * settlement reflows the transcript (the idle load strip unmounts at the
   * house rung; completion chrome mounts above it), the card slides out
   * from under the anchored pointer, and the eventual hit test lands on
   * `.message-body`. Enabled, then hover the settled card, then click — the
   * order a person's hand does it in.
   */
  await expect(fork).toBeEnabled();
  await answer.hover();
  await fork.click();
  await expect(page.locator(".composer-notice")).toContainText(
    /True fork created .* after this answer.*source conversation remains unchanged.*Carrying \d+ ancestor messages?; none omitted/u,
  );
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
 * The removed audit route is no longer a second place that interprets a
 * conversation. Sessions owns the bounded, local record: it states the linked
 * receipt count, the inspected event bound, and the transcript materialized
 * from that same session. A count is a local trace fact, not a trust verdict.
 */
test("Sessions states the bounded local trace record it inspected", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop Sessions trace contract");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
  const sessionId = page.url().split("#chat/")[1]!;
  const prompt = "Record something worth tracing locally.";
  await page.getByRole("combobox", { name: "Message Airship" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const answer = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  await expect(answer).toHaveAttribute("data-turn-id", /.+/u);

  // Hash navigation keeps the page-memory authority alive while opening the
  // current replacement for the removed audit route.
  await page.evaluate(() => { window.location.hash = "sessions"; });
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();
  const row = page.locator(`.session-library-row[data-session-id="${sessionId}"]`);
  await expect(row).toBeVisible();
  await row.locator(".session-library-card").click();

  const inspector = page.locator(".session-library-inspector");
  const integrity = inspector.getByRole("button", { name: /^Session integrity\./u });
  await expect(integrity).toHaveAccessibleName(/Structure passed.*1 receipt.*local inspection details/u);
  if (await integrity.getAttribute("aria-expanded") !== "true") await integrity.click();
  await expect(inspector.locator(".session-integrity__scope small"))
    .toHaveText(/\d+ of \d+ events inspected · 1 turn/u);
  await expect(inspector.getByRole("region", { name: "Conversation continuity" }))
    .toContainText(/Journal head\s*\d+ events?/u);

  const record = inspector.locator("details.session-library-technical");
  await expect(record.locator(":scope > summary"))
    .toContainText(/Manifest pins and transcript · 2 messages/u);
  await record.locator(":scope > summary").click();
  await expect(record.locator(".session-library-transcript")).toContainText(prompt);
  const pins = record.locator("details.session-library-pins-disclosure");
  await pins.locator(":scope > summary").click();
  await expect(pins.locator(".session-library-digests")).toContainText(/Journal head · \d+/u);
});
