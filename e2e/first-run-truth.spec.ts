import { expect, test } from "@playwright/test";

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
 * moment they were deciding whether to trust it.
 *
 * The sentence itself is worth keeping: a bookmark, a shared link or a back
 * button really can reach a conversation page memory could not hold, and a
 * person deserves to be told. Both halves are pinned here, because fixing the
 * first by deleting the second would trade a false claim for a silent one.
 */

const LOST_WORK_NOTICE = /did not survive the reload/u;

test("a first-ever visit does not claim a conversation was lost", async ({ page }, testInfo) => {
  const namespace = `first-run-${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}`);
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
  // Past the service-worker takeover and the reload it triggers.
  await page.waitForTimeout(2_500);
  await expect(page.locator(".composer-notice").filter({ hasText: LOST_WORK_NOTICE })).toHaveCount(0);
});

test("a conversation address that did not come from this tab is still reported", async ({ page }, testInfo) => {
  const namespace = `dead-link-${testInfo.project.name}-${Date.now().toString(36)}`;
  // Shaped like a real address and absent from this journal, which is what a
  // stale bookmark looks like.
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat/11111111-2222-4333-8444-555555555555`);
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".composer-notice").filter({ hasText: LOST_WORK_NOTICE }))
    .toBeVisible({ timeout: 20_000 });
});
