import { expect, test } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/**
 * The first screen may not report work nobody has done.
 *
 * A first visit to a static host loads the document twice on purpose: the
 * service worker takes control, `controllerchange` fires, and the shell reloads
 * so COOP/COEP are established before anyone starts working. Measured on a
 * never-visited namespace, that boot produced five main-frame navigations and
 * two distinct conversation ids — and because the composer canonicalises
 * `#chat/<id>` the moment a conversation exists, the pre-reload address
 * outlived the page-memory conversation it named.
 *
 * So the first thing a person ever read was "That conversation existed only in
 * page memory and did not survive the reload." Airship announced lost work, on
 * an empty screen, to someone who had not yet typed anything — at the exact
 * moment they were deciding whether the session status was accurate.
 *
 * The sentence itself is worth keeping: a bookmark, a shared link or a back
 * button really can reach a conversation page memory could not hold, and a
 * person deserves to be told. Both halves are pinned here, because fixing the
 * first by deleting the second would trade a false status for a silent one.
 */

const LOST_WORK_NOTICE = /did not survive the reload/u;

test("a first-ever visit starts a new unsaved conversation without reporting lost work", async ({ page }, testInfo) => {
  const namespace = `first-run-${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}`);
  await waitForShellSettled(page, { timeout: 30_000 });

  const about = page.getByRole("region", { name: "About this conversation" });
  await expect(about).toContainText("This conversation is not being saved.");
  await expect(about.getByRole("button", { name: /Keep it on this device/u })).toBeVisible();
  const sessionStatus = page.locator(".session-status-chip");
  await expect(sessionStatus).toHaveAccessibleName(/Session\. Ephemeral · content not saved\./u);
  await expect(sessionStatus.locator(".status-mark")).toHaveAttribute("data-state", "attention");
  await expect(page.locator(".composer-notice").filter({ hasText: LOST_WORK_NOTICE })).toHaveCount(0);
});

test("a conversation address that did not come from this tab reports the missing session", async ({ page }, testInfo) => {
  const namespace = `dead-link-${testInfo.project.name}-${Date.now().toString(36)}`;
  // Shaped like a real address and absent from this journal, which is what a
  // stale bookmark looks like.
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat/11111111-2222-4333-8444-555555555555`);
  await waitForShellSettled(page, { timeout: 30_000 });
  await expect(page.locator(".composer-notice").filter({ hasText: LOST_WORK_NOTICE }))
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "About this conversation" }))
    .toContainText("This conversation is not being saved.");
  await expect(page.locator(".session-status-chip .status-mark")).toHaveAttribute("data-state", "attention");
});
