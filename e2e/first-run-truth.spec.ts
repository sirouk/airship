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

  /*
   * And the comparison a person needs in order to make this choice is open,
   * on the screen they made it from.
   *
   * Measured on the built tree at 3114a9b, iPhone 13: this same click landed
   * with `details.vault-provider-compare` reporting `open: false`, while the
   * route's own "Choose a durable provider" button opened it and every desktop
   * path opened it. The six answers were one tap away, on the one screen where
   * a person is deciding where their work lives.
   */
  const compare = route.locator("details.vault-provider-compare");
  await expect(compare).toHaveAttribute("open", "");
  await expect(compare.getByRole("table")).toBeVisible();
  for (const question of ["Survives closing the tab", "Works offline", "Reaches other devices", "You supply", "You keep", "What can lose it"]) {
    await expect(compare.getByRole("rowheader", { name: question, exact: true })).toBeVisible();
  }
});

/**
 * What the first screen says this is, before anybody types.
 *
 * Measured on a cold load of the built tree at 3114a9b, desktop and phone:
 * `document.body.innerText` matched neither /browser/i nor /no server/i, and
 * matched /kernel/i three times. The only live region carrying any text
 * announced "Local kernel ready", so that was the first sentence a
 * screen-reader user was given, and the boot heading above it read "Preparing
 * the local kernel". The paragraph that does explain the product arrived only
 * after a message had been sent.
 *
 * Both halves are pinned here. Saying what Airship is must not cost the
 * sentences that say what will not be kept and that the composer is a demo —
 * those are the honest ones, and they are asserted in the same breath.
 */
test("the first screen says what Airship is, in words a newcomer already has", async ({ page }, testInfo) => {
  const namespace = `what-is-this-${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}`);
  await waitForShellSettled(page, { timeout: 30_000 });

  const about = page.getByRole("region", { name: "About this conversation" });
  await expect(about).toContainText("Airship runs in your browser. There is no Airship server and no account to create.");
  // Not at the cost of either sentence that was already true.
  await expect(about).toContainText("This conversation is not being saved.");
  await expect(about).toContainText("Chat needs a model provider; this composer is a deterministic demo.");

  // And no screen the person has not asked for: this is one paragraph, before
  // the two that were already there.
  const order = await about.evaluate((node) => [...node.querySelectorAll("p")].map((p) => (p.textContent ?? "").trim().slice(0, 40)));
  expect(order[0]).toContain("Airship runs in your browser");
});

test("the shell says starting and ready without the word kernel", async ({ page }, testInfo) => {
  const namespace = `plain-status-${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}`);
  await waitForShellSettled(page, { timeout: 30_000 });

  const spoken = page.locator('.sr-only[role="status"]').filter({ hasText: /Airship/u });
  await expect(spoken.first()).toHaveText("Airship is ready on this device", { timeout: 20_000 });
  await expect(page.locator(".runtime-line__text").first()).toHaveText("Airship is ready on this device");
  expect(await page.evaluate(() => (document.body.textContent ?? "").match(/kernel/giu)?.length ?? 0)).toBe(0);
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
