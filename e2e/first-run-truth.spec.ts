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

/**
 * A first-run promise has to land somewhere that keeps it.
 *
 * "Keep it on this device →" navigated to `#vault` and stopped, with Ephemeral
 * still the selected provider — measured on the built tree, the destination read
 * "Ephemeral · page memory only / No cloud or device Vault is attached", and the
 * person still had to find the picker, find Local Device in it, and then find
 * the ceremony. The sentence named an outcome the destination did not offer.
 *
 * Selecting the destination is the whole fix, and it commits nothing: the Local
 * Device Vault is enrolled by a key ceremony the person completes on that
 * screen, "nothing is enrolled until you save that key", and Ephemeral is one
 * press away in the same picker.
 */
test("the first-run keep link lands on the destination that keeps it, with its ceremony on screen", async ({ page }, testInfo) => {
  const namespace = `keep-here-${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}`);
  await waitForShellSettled(page, { timeout: 30_000 });

  await page.getByRole("region", { name: "About this conversation" })
    .getByRole("button", { name: /Keep it on this device/u }).click();

  await expect(page).toHaveURL(/#vault$/u);
  const route = page.getByRole("main");
  // The destination, selected — not merely offered somewhere on the route.
  await expect(page.locator(".vault-provider-selector .menu-select-trigger")).toContainText("Local Device");
  await expect(route).toContainText("Keep this browser’s work on this device");
  // And the ceremony, on screen, with the two controls that start it.
  await expect(route.getByRole("button", { name: "Create a device Vault" })).toBeVisible({ timeout: 20_000 });
  await expect(route.locator("[data-vault-create]")).toBeVisible();
  // Nothing has been enrolled by the navigation, and the route says so.
  await expect(route).toContainText("Nothing is enrolled until you save that key");
  await expect(route).toContainText("Not set up yet");
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
