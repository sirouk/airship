import { expect, test, type Page } from "@playwright/test";
import { completeLocalDeviceCeremony } from "./support/vault-ceremony";
import { setProfilePresentationDensity } from "./support/density";

/**
 * A finished conversation is continued by opening it, not by forking it.
 *
 * Driven in a browser on the build before this spec existed: send one turn,
 * open Profiles, choose a different interface theme, "Save new revision",
 * "Switch to this profile". The theme reaches nothing a turn is run by — not
 * the instructions, not the skills, not the workspace, memory, approval or
 * provider boundaries — and yet:
 *
 *   - the finished conversation's primary action became a gold "Fork to
 *     continue", with its Resume button reading "Fork required", disabled;
 *   - its integrity row read "Structure passed · Fork required" directly above
 *     "Journal structure passed · 11 of 11 events inspected · Last turn
 *     completed";
 *   - the row's one-press "Open" refused and left the route on `#sessions`;
 *   - and the profile itself reported that it "had no compatible conversation,
 *     so Airship started one", minting an empty conversation over the top.
 *
 * The cause was that resumability was decided by digest equality with whatever
 * revision happened to be selected — `profileRevision`, `themeDigest`,
 * `resolutionDigest` — all of which move for an edit that changes nothing a
 * turn is governed by. `src/sessions/profile-cockpit.test.ts` holds the same
 * computed resumability boundary: "Fork required" is reserved for pins that
 * genuinely no longer resolve.
 *
 * This spec drives the person's journey, not the digests: change a setting,
 * come back, click the conversation, keep talking in it. The guard that must
 * survive is `still refuses ...` at the bottom, which changes something a turn
 * really is governed by and expects the refusal to stand.
 */

const COMPOSER = { role: "combobox" as const, name: "Message Airship" };

async function sendOneTurn(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole(COMPOSER.role, { name: COMPOSER.name });
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message.user").filter({ hasText: prompt })).toBeVisible({ timeout: 20_000 });
  // The turn is over when its finalized local run record reaches the answer,
  // not when the composer clears or the first token lands. The raw completion
  // footer is instrumented-only; Balanced exposes this neutral trace row.
  const answer = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  const run = answer.getByRole("button", { name: /^Run details\./u });
  await expect(run).toBeVisible({ timeout: 40_000 });
  await expect(run).toHaveText(/^Run · .+ · [0-9a-f]{8}$/u);
}

/**
 * The Vault is the authority being written through, on either shell.
 *
 * Deliberately not `expectLocalDeviceVaultActive`: the runtime line it waits
 * on is a desktop topbar element, and in the phone shell the same span is
 * rendered with the right sentence and `hidden`. Waiting for it to be *visible*
 * failed this journey on mobile for a reason that has nothing to do with
 * resuming a conversation. What this needs to know is that adoption happened
 * before the first turn is sent, and the sentence's presence is that fact.
 */
async function expectVaultAdopted(page: Page): Promise<void> {
  /* The sentence lives on one runtime-line carrier per shell — the topbar
     line on the desktop shell and the track that resumes it on the phone
     shell — so the adoption check is about *one visible carrier*, never
     about the count: the two shells exist in the DOM at every width now,
     which is what the older CARRIER-count contract measured. */
  /* `.first()` is DOM order, not visibility, and the two carriers are
     display-exclusive: the topbar line comes first in the document and is
     `display: none` at phone widths, so on the mobile project this resolved to
     the hidden copy and then waited 40 s for it to become visible — which it
     never can. The paragraph above says the check is about one *visible*
     carrier; this is that sentence as a selector. */
  await expect(page.locator(".runtime-line__text")
    .filter({ hasText: /Encrypted Local Device vault active/u })
    .filter({ visible: true })
    .first())
    .toBeVisible({ timeout: 40_000 });
}

/** Change something the person can see and nothing a turn is run by. */
async function saveANewThemeRevision(page: Page, namespace: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#profiles`);
  await expect(page.getByRole("heading", { name: "Profiles", level: 1 })).toBeVisible({ timeout: 20_000 });
  await page.locator('.theme-options button:has(strong:text-is("Verdigris"))').click();
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: "Switch to this profile" })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Switch to this profile" }).click();
  await expect(page.getByRole(COMPOSER.role, { name: COMPOSER.name })).toBeVisible({ timeout: 30_000 });
}

async function openLibrary(page: Page, namespace: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#sessions`);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible({ timeout: 20_000 });
}

function card(page: Page, title: string) {
  return page.locator(".session-library-card").filter({ hasText: title }).first();
}

test.describe("a conversation you finished yesterday", () => {
  test("is resumed by clicking it after the profile's presentation changed", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const namespace = `resume-no-fork-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now().toString(36)}`;
    await page.goto(`/?airshipLabNamespace=${namespace}#vault`);
    await completeLocalDeviceCeremony(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await expectVaultAdopted(page);
    /* Finalized Run details are telemetry: the house default — minimal —
       unmounts them. This journey waits on that local completion record, so it
       runs one rung up where the record exists. */
    await setProfilePresentationDensity(page, "Balanced");
    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
    await sendOneTurn(page, "Draft the Q3 pricing memo intro paragraph.");

    await saveANewThemeRevision(page, namespace);

    /*
     * The profile keeps the conversation it had. Before this, the welcome card
     * announced that the profile "had no compatible conversation, so Airship
     * started one" — over the top of a conversation that was one theme old.
     */
    await expect(page.locator(".message").filter({ hasText: /had no compatible conversation/u })).toHaveCount(0);
    await expect(page.locator(".message").filter({ hasText: /was not resumed/u })).toHaveCount(0);

    // A second conversation, so the finished one is something you come back to
    // rather than something you are already in.
    const firstUrl = page.url();
    await page.getByRole("region", { name: "Agent session" })
      .getByRole("button", { name: "New conversation" }).click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toBe(firstUrl);
    await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
    await sendOneTurn(page, "Summarise the competitive landscape.");

    await openLibrary(page, namespace);
    await card(page, "Draft the Q3 pricing memo").click();

    // The verdict, in the words of the surface that decides it.
    const actions = page.locator(".session-library-actions");
    await expect(actions.getByRole("button", { name: "Resume conversation" })).toBeEnabled({ timeout: 20_000 });
    await expect(actions.getByRole("button", { name: "Fork to continue" })).toHaveCount(0);
    const integrity = page.getByRole("button", { name: /^Session integrity\./u });
    await expect(integrity).toHaveAccessibleName(/Ready to resume/u);
    // And the same conversation is not simultaneously called unfinished.
    await expect(integrity).not.toHaveAccessibleName(/Fork required/u);

    // The journey: one press on the row's own opener puts you back in it.
    await page.locator(".session-library-row").filter({ hasText: "Draft the Q3 pricing memo" })
      .getByRole("button", { name: /^Open / }).click();
    await expect(page).toHaveURL(/#chat\//u, { timeout: 30_000 });
    await expect(page.locator(".message.user").filter({ hasText: "Draft the Q3 pricing memo" })).toBeVisible({ timeout: 30_000 });
    const resumedUrl = page.url();

    // And it is genuinely that conversation being continued: the next turn
    // lands in the same session, with the earlier turn still above it.
    await sendOneTurn(page, "Now add a second paragraph about packaging.");
    expect(page.url()).toBe(resumedUrl);
    await expect(page.locator(".message.user").filter({ hasText: "Draft the Q3 pricing memo" })).toBeVisible();
    await expect(page.locator(".message.user").filter({ hasText: "second paragraph about packaging" })).toBeVisible();

    // No branch was created to make that possible.
    await openLibrary(page, namespace);
    await expect(page.locator(".session-library-card")).toHaveCount(2);
    await expect(page.locator(".session-library-card").filter({ hasText: "↳ from" })).toHaveCount(0);
  });

  test("still refuses when the profile's approval policy moved under it", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const namespace = `resume-guard-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now().toString(36)}`;
    await page.goto(`/?airshipLabNamespace=${namespace}#vault`);
    await completeLocalDeviceCeremony(page);
    await page.goto(`/?airshipLabNamespace=${namespace}`);
    await expectVaultAdopted(page);
    await setProfilePresentationDensity(page, "Balanced");
    await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
    await sendOneTurn(page, "Draft the Q3 pricing memo intro paragraph.");

    /*
     * Approval policy is a boundary a turn is genuinely governed by: a
     * conversation pinned under "Ask First" may not be continued under "Full
     * Access" because it agreed to be asked. This is the refusal the fix above
     * must not have swallowed.
     */
    await page.goto(`/?airshipLabNamespace=${namespace}#profiles`);
    await expect(page.getByRole("heading", { name: "Profiles", level: 1 })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Profile approval policy" }).click();
    await page.getByRole("option", { name: "Full Access" }).click();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByRole("button", { name: "Switch to this profile" })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: "Switch to this profile" }).click();
    await expect(page.getByRole(COMPOSER.role, { name: COMPOSER.name })).toBeVisible({ timeout: 30_000 });

    await openLibrary(page, namespace);
    await card(page, "Draft the Q3 pricing memo").click();
    const actions = page.locator(".session-library-actions");
    await expect(actions.getByRole("button", { name: "Fork to continue" })).toBeVisible({ timeout: 20_000 });
    await expect(actions.getByRole("button", { name: "Resume conversation" })).toHaveCount(0);
    // And it says which boundary, rather than asserting the history is broken.
    await page.getByRole("button", { name: /^Session integrity\./u }).click();
    const body = page.locator(".session-integrity__body").first();
    await expect(body).toContainText(/approval policy/u);
    await expect(body).not.toContainText(/ended mid-turn/u);
  });
});
