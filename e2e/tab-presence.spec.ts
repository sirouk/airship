import { expect, test } from "@playwright/test";

/**
 * The "open in another tab" warning has to be able to stop being true.
 *
 * It latched: one `hello`, one `present`, and `setPeer(true)` was the last
 * state change the component ever made. Closing the second tab left the first
 * one warning that page-memory state was not shared with a tab that no longer
 * existed, on every route, for the rest of the session — and the only reason it
 * survived review is that a source read shows a correct-looking listener. Two
 * real tabs are what tell the truth, which is why this is measured here and not
 * asserted in `tab-presence.test.ts` beside the roster's own transitions.
 *
 * Both directions on purpose. A warning that never appears is as wrong as one
 * that never leaves, and shortening the latch into a warning nobody sees would
 * pass a one-sided test.
 */

const NOTE = /Open in another tab/;

test.describe("the multi-tab warning tracks the tabs that exist", () => {
  test("appears when a second tab opens and clears when it closes", async ({ context }) => {
    const first = await context.newPage();
    await first.goto("/?airshipLabNamespace=tab-presence#chat");
    await expect(first.locator("h1").first()).toBeVisible({ timeout: 20_000 });
    await expect(first.getByText(NOTE)).toHaveCount(0);

    const second = await context.newPage();
    await second.goto("/?airshipLabNamespace=tab-presence#chat");
    await expect(second.locator("h1").first()).toBeVisible({ timeout: 20_000 });

    // The arrival answers, and the arriving tab learns about the incumbent from
    // that answer — so both of them say it, not just the one that was already
    // open.
    await expect(first.getByText(NOTE)).toHaveCount(1, { timeout: 10_000 });
    await expect(second.getByText(NOTE)).toHaveCount(1, { timeout: 10_000 });

    await second.close();
    /*
     * Seconds, not the 90s heartbeat expiry: closing a tab broadcasts a
     * departure, and the expiry exists only for the tab that crashes without
     * getting the chance to. A timeout long enough to be satisfied by the
     * expiry would stop testing the departure at all.
     */
    await expect(first.getByText(NOTE)).toHaveCount(0, { timeout: 10_000 });
  });
});
