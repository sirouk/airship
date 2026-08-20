import { expect, test, type Page } from "@playwright/test";
import { MOBILE_PRIMARY_CONTROLS } from "../src/ui/navigation-model";
import { setProfilePresentationDensity } from "./support/density";
import { waitForShellSettled } from "./support/settled";

/*
 * The rail's recents disclosure now opens itself the first time a profile turns
 * out to have conversations in it — capability coming forward rather than
 * waiting to be found. These specs were written when it always started closed,
 * so an unconditional "Expand" click had become a coin flip: when the effect
 * had already fired, the affordance said Collapse and the click either missed
 * or shut the list the test was about to read.
 *
 * So they state what they need instead of assuming it.
 */
async function openRailRecents(scope: import("@playwright/test").Locator): Promise<void> {
  const expand = scope.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
}

test("every conversation has a stable addressed URL and new conversations do not overwrite it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop addressed conversation contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page.locator(".app-shell")).toBeVisible();
  /*
   * Past the boot reload before the address is trusted.
   *
   * A cold visit mints a conversation address, the service worker takes control
   * and the document reloads, and a second, different address is minted — see
   * `waitForShellSettled`. `.app-shell` is visible in the document about to be
   * replaced and the address pattern matches the address about to be abandoned,
   * so every URL captured here was the wrong one and every round trip back to
   * it "failed" by returning the right conversation.
   */
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const firstUrl = page.url();

  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await expect.poll(() => page.url()).not.toBe(firstUrl);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);

  /*
   * Unconditional, deliberately.
   *
   * This was `if (await firstConversation.count()) { … }` — a guard that turns
   * "the rail never rendered the other conversation" into a silent pass, on the
   * one assertion in the file that opens a thread from the rail. The rail row
   * that does not open its conversation shipped underneath it. A row that is
   * not there is the failure, not a reason to skip the check.
   */
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const expand = navigation.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
  const firstConversation = navigation
    .locator("#airship-recent-conversations .recent-conversation:not(.active)")
    .first();
  await expect(firstConversation).toBeVisible();
  await firstConversation.click();
  await expect(page).toHaveURL(firstUrl);
});

test("All conversations returns to the active thread as navigation, not recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop active-conversation navigation contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  // Past the service-worker control reload; capture the durable address, not
  // the first document's page-memory session.
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const threadUrl = page.url();

  const navigation = page.getByRole("navigation", { name: "Primary" });
  await openRailRecents(navigation);
  await navigation.getByRole("button", { name: "All conversations", exact: true }).click();
  await expect(page).toHaveURL(/#sessions$/);

  await page.getByRole("button", { name: /Return to .+/u }).click();

  await expect(page).toHaveURL(threadUrl);
  await expect(page.locator(".session-library-compatibility.blocked")).toHaveCount(0);
  await expect(page.getByText(/resume blocked|model mismatch|fork required/iu)).toHaveCount(0);
});

test("desktop chat title supports durable inline rename", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop inline rename contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page.locator(".app-shell")).toBeVisible();

  await page.locator(".session-bar__identity-button").dblclick();
  const input = page.getByRole("textbox", { name: "Conversation title" });
  await expect(input).toBeVisible();
  await input.fill("Inline rename survives navigation");
  // Leaving the title is the terminal-style save gesture requested in the
  // product review. The durable journal event then repopulates the rail list.
  await page.getByRole("combobox", { name: "Message Airship" }).click();

  await expect(page.locator(".session-bar__title")).toHaveText("Inline rename survives navigation");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await openRailRecents(navigation);
  await expect(navigation.getByRole("group", { name: "Profile conversations" }))
    .toContainText("Inline rename survives navigation");
});

/*
 * The gesture changed; the contract did not.
 *
 * This used to press a pencil button in the chip row, which existed because a
 * thumb has neither double-click nor F2. It was a second control for the verb
 * that acts on the element beside it, taking a 44px slot on the one row that
 * also has to hold the conversation's name and three indicators — so the title
 * became the control and the button went. What still has to be true is that
 * touch can rename at all, and that the rename is durable enough to reach the
 * library, which is what the rest of this test measures.
 */
test("mobile renames a conversation durably by tapping its title", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile rename contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page.locator(".app-shell")).toBeVisible();
  // The pencil may not come back: two controls for one verb is what this row
  // could least afford.
  await expect(page.getByRole("button", { name: "Rename conversation" })).toHaveCount(0);
  await page.locator(".session-bar__identity-button").tap();
  const input = page.getByRole("textbox", { name: "Conversation title" });
  await expect(input).toBeVisible();
  await input.fill("Mobile rename persists");
  await input.press("Enter");
  await expect(page.locator(".session-bar__title")).toHaveText("Mobile rename persists");

  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "All conversations" }).click();
  await expect(page.getByRole("region", { name: "All conversations" })).toContainText("Mobile rename persists");
});

/*
 * The other direction of the same durable rename.
 *
 * Chat → library was already covered; library → Chat was not, and the rename
 * result used to live entirely in the library's own refresh counter while the
 * host held the only copies Chat and the rail read. So this walks back to Chat
 * with no intervening turn, favourite toggle or resume: nothing but the host
 * adopting the rename can put the new title on either surface.
 */
test("a rename from All conversations reaches the chat title and the rail recents", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop library rename propagation contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const conversation = page.url();

  // In-app navigation, not a reload: a reload would restart the runtime and
  // hide the propagation this test is about.
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await openRailRecents(navigation);
  await navigation.locator("#airship-recent-conversations").getByRole("button", { name: "All conversations", exact: true }).click();
  await expect(page).toHaveURL(/#sessions$/);

  // The library opens on the active conversation, so Rename targets it.
  await page.getByRole("button", { name: "Rename", exact: true }).first().click();
  const field = page.getByRole("textbox", { name: "Conversation title" });
  await expect(field).toBeVisible();
  await field.fill("Renamed from library");
  await page.getByRole("button", { name: "Save rename" }).click();
  await expect(page.getByRole("heading", { name: "Renamed from library", level: 2 })).toBeVisible();

  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(conversation);
  await expect(page.locator(".session-bar__title")).toHaveText("Renamed from library");
  // Whether the disclosure survived the round trip is not this contract, so
  // re-open it if it did not; what is asserted is the name it now carries.
  const expand = navigation.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
  await expect(navigation.getByRole("group", { name: "Profile conversations" }))
    .toContainText("Renamed from library");
});

test("conversation branches preserve their source and navigate back through lineage", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop immutable branch contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const sourceUrl = page.url();
  // Forked from a real turn rather than from the welcome card. That card is
  // gone: it attributed a speaker for a message no model produced and offered
  // Retry and Branch on it, neither of which had a referent. Branching a turn
  // that actually happened is the stronger version of this contract.
  const seedComposer = page.getByRole("combobox", { name: "Message Airship" });
  await seedComposer.fill("Explain immutable context in one sentence.");
  await page.getByRole("button", { name: "Send message" }).click();
  const message = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  await expect(message.getByRole("button", { name: "Retry" })).toBeEnabled();
  const fork = message.getByRole("button", { name: "Fork from here" });
  await expect(fork).toBeEnabled();
  /*
   * Hover anchors the pointer; it does not keep it there. The actions
   * toolbar arms `pointer-events` only under a live `:hover`, and a
   * settling turn reflows the transcript out from under a pointer anchored
   * before it — at the house rung the idle load strip unmounts on
   * completion, one rung up the receipt and evidence chips mount; either
   * way the hit test that follows lands on `.message-body` instead of the
   * button. So the gesture order is the human one: wait for the settled
   * card, hover it, then click.
   */
  await message.hover();
  await fork.click();
  // The notice names the boundary and the reach of the bounded seed. It used
  // to claim "audited context through this answer" unconditionally, which is a
  // completeness claim the bounded fork seed does not guarantee.
  await expect(page.locator(".composer-notice")).toContainText("True fork created at the audited boundary after this answer");
  await expect(page.locator(".composer-notice")).toContainText(/Carrying \d+ ancestor message/u);
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toHaveValue("");
  // Cross the draft debounce and the route-request → active-session
  // normalization. Neither may invent a copied prompt in a true fork.
  await page.waitForTimeout(240);
  await expect(composer).toHaveValue("");
  const lineage = page.getByRole("button", { name: /Branch from #/u });
  await expect(lineage).toBeVisible();
  await lineage.click();
  await expect(page).toHaveURL(sourceUrl);
});

test("edit and retry create distinct immutable branches", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop branch-aware message actions");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const sourceUrl = page.url();
  const prompt = "Explain why immutable branches are useful.";
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const user = page.locator('[data-transcript-card][data-message-role="user"]').last();
  const editBranch = user.getByRole("button", { name: "Edit & branch" });
  // Same hover law as the fork above: the toolbar arms only under a live
  // hover, and the turn settling reflows the transcript out from under a
  // pointer anchored earlier. Enabled first, then hover, then click.
  await expect(editBranch).toBeEnabled();
  await user.hover();
  await editBranch.click();
  await expect(page.locator(".composer-notice")).toContainText("immutable pre-turn boundary");
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  const editUrl = page.url();
  await expect(composer).toHaveValue(prompt);
  await page.getByRole("button", { name: /Branch from #/u }).click();
  await expect(page).toHaveURL(sourceUrl);

  const assistant = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  const retry = assistant.getByRole("button", { name: "Retry" });
  // Re-anchor hover on the settled, re-rendered card before clicking: the
  // round trip through the branch replaced the card under the old pointer.
  await expect(retry).toBeEnabled();
  await assistant.hover();
  await retry.click();
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  await expect(page).not.toHaveURL(editUrl);
  await expect(page.locator('[data-transcript-card][data-message-role="user"]')).toContainText(prompt);
  await expect(composer).toHaveValue("");
});

test("each addressed conversation restores its own unsent draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop conversation draft contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const sourceUrl = page.url();
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("An unsent source-conversation draft");
  await page.waitForTimeout(220);
  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  await expect(composer).toHaveValue("");

  // AMENDED: the conversation list is a disclosure now, so it is opened before
  // it is read. The rows, their order and their targets are unchanged.
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await openRailRecents(navigation);
  const source = navigation
    .locator("#airship-recent-conversations .recent-conversation:not(.active)")
    .first();
  await source.click();
  await expect(page).toHaveURL(sourceUrl);
  await expect(composer).toHaveValue("An unsent source-conversation draft");
});

test("an addressed draft survives a full page reload before session resume", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop reload draft contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const addressedUrl = page.url();
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("Restore this addressed draft after reload");
  await page.waitForTimeout(220);

  await page.reload();

  // AMENDED: the address itself no longer survives, and that is deliberate. A
  // conversation held only in page memory is permanently absent after a
  // reload, so the deep-link resolver now retires the dead address and says so
  // instead of holding the URL open for a conversation that can never load
  // (src/sessions/session-library.test.ts, "routes only absence through the
  // deep-link reset"). What must survive is the person's unsent text, and the
  // assertions below are stronger than the single `toHaveURL(addressedUrl)`
  // they replace: the draft has to be re-homed on the conversation that is
  // actually open, proven by surviving a *second* reload from its new address.
  // The old assertion also only ever passed on a race — the first URL poll ran
  // before canonicalisation rewrote the hash.
  await expect(page.locator(".app-shell")).toBeVisible();
  await waitForShellSettled(page);
  await expect(composer).toHaveValue("Restore this addressed draft after reload");
  await expect(page.locator(".composer-notice")).toContainText("did not survive the reload");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  await expect.poll(() => page.url()).not.toBe(addressedUrl);
  const rehomedUrl = page.url();

  await page.reload();

  await expect(page.locator(".app-shell")).toBeVisible();
  await waitForShellSettled(page);
  await expect(composer).toHaveValue("Restore this addressed draft after reload");
  await expect.poll(() => page.url()).not.toBe(rehomedUrl);
});

test("desktop treats Chat as the conversation disclosure and preserves the full ledger", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop conversation information architecture");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Sessions", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");

  // The profile-local thread tree expands directly beneath Chat. It is bounded
  // to the rail, keeps the complete-ledger action reachable, and names the
  // active profile rather than presenting a global session bucket.
  /*
   * The disclosure comes forward on its own now, so this asserts the contract
   * rather than the old default.
   *
   * It used to pin "Expand recent conversations" with `aria-expanded="false"`
   * and no panel — a rail that starts closed and waits to be found. The rail
   * opens the list the first time the profile turns out to have something in
   * it, which is the product law about capability coming forward, and the
   * button renamed itself to match. The claims worth holding are unchanged and
   * are all still made below: the panel exists, it is bounded to the rail, its
   * label agrees with its state, and a person can close it and open it again.
   */
  const recent = navigation.locator("#airship-recent-conversations");
  await expect(recent).toBeVisible();
  const collapse = navigation.getByRole("button", { name: "Collapse recent conversations" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  // Closing is the person's choice and it must actually close.
  await collapse.click();
  await expect(navigation.locator("#airship-recent-conversations")).toHaveCount(0);
  const disclosure = navigation.getByRole("button", { name: "Expand recent conversations" });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(recent).toBeVisible();
  await expect(recent).toContainText("General conversations");
  expect(await recent.locator(".recent-conversation").count()).toBeLessThanOrEqual(10);
  const navigationBox = await navigation.boundingBox();
  const inlineTreeBox = await recent.boundingBox();
  expect(inlineTreeBox!.x).toBeGreaterThanOrEqual(navigationBox!.x);
  expect(inlineTreeBox!.x + inlineTreeBox!.width).toBeLessThanOrEqual(navigationBox!.x + navigationBox!.width + 1);
  await expect(navigation.getByRole("button", { name: "Collapse recent conversations" })).toHaveAttribute("aria-expanded", "true");
  const ledger = recent.getByRole("button", { name: "All conversations", exact: true });
  const ledgerBox = await ledger.boundingBox();
  const panelBox = await recent.boundingBox();
  expect(ledgerBox!.y + ledgerBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  await ledger.click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();

  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  // `.session-id` and its "20 recorded steps" sibling are one journal chip
  // now: same target, same destination, and the count is no longer a
  // separate string beside the id.
  await page.locator(".journal-chip__record").click();
  await expect(page).toHaveURL(/#sessions$/);
});

test("desktop favorites remain journal-backed and isolated to the active profile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile favorite contract");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await openRailRecents(navigation);
  const tree = navigation.getByRole("group", { name: "Profile conversations" });
  const active = tree.locator(".recent-conversation.active");
  await expect(active).toBeVisible();
  const title = (await active.locator("strong").textContent())?.trim();
  expect(title).toBeTruthy();
  await tree.getByRole("button", { name: `Add to favorites ${title!}` }).click();
  await expect(tree.getByText("Favorites", { exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: `Remove from favorites ${title!}` })).toBeVisible();

  const profile = page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" });
  await profile.click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await listbox.getByRole("option", { name: "Research", exact: true }).click();
  await expect(tree).toContainText("Research conversations");
  await expect(tree.getByRole("button", { name: `Remove from favorites ${title!}` })).toHaveCount(0);

  await profile.click();
  await listbox.getByRole("option", { name: "General", exact: true }).click();
  await expect(tree).toContainText("General conversations");
  await expect(tree.getByRole("button", { name: `Remove from favorites ${title!}` })).toBeVisible();
});

test("mobile keeps conversations out of the fixed bar and exposes the ledger through More", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile conversation information architecture");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const originalConversation = page.url();
  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await expect.poll(() => page.url()).not.toBe(originalConversation);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(navigation.getByRole("button", { name: "Sessions", exact: true })).toHaveCount(0);
  /*
   * AMENDED 4 → 5, and read out of the model rather than pinned again.
   *
   * The literal was a description of one arrangement, not a contract: the band
   * is `MOBILE_PRIMARY_CONTROLS`, including the promoted Memory route and the
   * direct Providers entry. Their slots came from the shell's live-load reading,
   * which counted execution-pack runs and
   * therefore read `0 · Idle` on a phone from first paint to tab close.
   *
   * The claim this line actually makes is the one that matters and it is
   * unchanged: the fixed bar holds the primary controls and *only* those, so a
   * conversation ledger cannot appear in it. Derived from the model so it
   * cannot go stale a third time — `design-contract.test.ts` asserts the grid
   * has exactly this many equal tracks, from the same source.
   */
  await expect(navigation.getByRole("button")).toHaveCount(MOBILE_PRIMARY_CONTROLS.length);
  await navigation.getByRole("button", { name: "More", exact: true }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await more.getByRole("button").filter({ hasText: "All conversations" }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();
});

test("Workspace owns one Editor and Terminal while preserving the legacy Sources deep link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop nested workspace information architecture");
  await page.goto("/#workspace");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Sources", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Editor", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Terminal", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page).toHaveURL(/#editor$/);
  await expect(page.getByRole("tab", { name: "Sources", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Explorer", exact: true })).toBeVisible();
  await page.goto("/#sources");
  await expect(page).toHaveURL(/#editor$/);
  await expect(page.getByRole("dialog", { name: "Advanced source controls" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Source Control/u })).toBeVisible();
  await navigation.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page).toHaveURL(/#terminal$/);
});

test("Editor source tools default to a collapsible tree and Profiles archives without stranding history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop management information architecture");
  await page.goto("/#editor");
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: "Advanced source controls" }).click();
  const sourceTools = page.getByRole("dialog", { name: "Advanced source controls" });
  await expect(sourceTools).toBeVisible();
  const tree = page.getByRole("button", { name: "Tree", exact: true });
  const flat = page.getByRole("button", { name: "Flat", exact: true });
  await expect(tree).toHaveAttribute("aria-pressed", "true");
  await flat.click();
  await expect(flat).toHaveAttribute("aria-pressed", "true");
  await tree.click();
  const folder = page.locator(".git-change-folder").first();
  if (await folder.count()) {
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "false");
  }

  await page.goto("/#profiles");
  const danger = page.locator("details.profile-danger-disclosure");
  await danger.locator("summary").click();
  const remove = page.getByRole("button", { name: /Remove profile|Only profile/u });
  await expect(remove).toBeDisabled();
  await page.locator(".profile-card").filter({ hasText: "Research" }).click();
  await expect(remove).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.getByText(/Removed from new work/u)).toBeVisible();
  await expect(page.locator(".profile-card").filter({ hasText: "Research" })).toHaveCount(0);
});

test("Memory unifies federated search, graph, and the legacy Context index deep link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop memory information architecture");
  await page.goto("/#memory");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Context", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Search|Graph|Index/u })).toHaveCount(0);
  const query = page.getByRole("searchbox", { name: "Search every memory surface" });
  await expect(query).toBeVisible();
  await expect(page.getByText("Current conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("Active profile memory", { exact: true })).toBeVisible();
  await expect(page.getByText("Workspace & sources", { exact: true })).toBeVisible();
  const relationships = page.locator("#memory-relationships");
  await expect.poll(() => relationships.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
  await expect(page.getByLabel("Interactive memory relationship graph")).toBeVisible();
  const index = page.locator("#memory-index");
  /*
   * Asserted before any query exists, because "closed" is only a claim about
   * arrival. The route opens this section itself the first time a search settles
   * (`src/ui/memory-view.tsx:692-695`), so asserting it closed *after* the fill
   * raced the route's own writer — a race no timeout can win, and the same shape
   * that reddened the integration gate at `profile-silo.spec.ts`.
   */
  await expect.poll(() => index.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  await query.fill("workspace");
  await expect(relationships.getByText("Graph matches for “workspace”", { exact: true })).toBeVisible();
  await expect(page.locator("#memory-results").getByRole("status")).toContainText(/Searching|current/u);
  await openMemoryIndex(page);
  await expect(page.getByRole("status", { name: "Shared Memory query in the workspace index" })).toContainText("Following “workspace”");

  await page.goto("/#context");
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
  const deepLinkedIndex = page.locator("#memory-index");
  await expect.poll(() => deepLinkedIndex.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
  await expect(page.getByLabel("Context index status")).toBeVisible();
  // A deep link opens Index but keeps the route heading in view. The arrival
  // row states the destination without jumping the whole page below its title.
  await expect.poll(() => page.locator("main").evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator(".memory-index-arrival")).toContainText(
    "Opened from the Memory index destination",
  );
});

test("Memory workspace results open the exact file in the editor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop Memory source navigation contract");
  await page.goto("/#memory");
  await page.getByRole("searchbox", { name: "Search every memory surface" }).fill("workspace");
  const hit = page.locator("#memory-results .memory-hit").filter({
    has: page.getByRole("button", { name: "Open in editor" }),
  }).first();
  await expect(hit).toBeVisible();
  const path = (await hit.locator("header strong").innerText()).trim();
  const name = path.slice(path.lastIndexOf("/") + 1);

  await hit.getByRole("button", { name: "Open in editor" }).click();

  await expect(page).toHaveURL(/#editor$/);
  await expect(page.getByRole("textbox", { name: `Edit ${name}` })).toBeVisible();
  await expect(page.locator(".editor-strip__path")).toContainText(path.replace("/workspace/", ""));
});

test("Memory disclosures and graph stay inside the mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile memory overflow contract");
  await page.goto("/#memory");
  await page.getByRole("searchbox", { name: "Search every memory surface" }).fill("workspace");
  await expect(page.locator("#memory-relationships")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // The horizontally scrolling jump strip that was measured here is gone; the
  // route's own sections carry their counts. What it was protecting — that
  // nothing on Memory pushes the phone viewport sideways — is asserted above
  // and again at the end of this journey.
  await expect(page.locator(".memory-scope-rail")).toHaveCount(0);
  const graph = page.getByLabel("Interactive memory relationship graph");
  await expect(graph).toBeVisible();
  const graphBounds = await graph.boundingBox();
  expect(graphBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((graphBounds?.x ?? 0) + (graphBounds?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual((await page.evaluate(() => window.innerWidth)) + 1);
  const match = page.locator("#memory-relationships .memory-graph-query button").first();
  await expect(match).toBeVisible();
  await match.click();
  await expect(page.locator("#memory-relationships .memory-node-detail h2")).toBeVisible();
  await openMemoryIndex(page);
  await expect(page.getByRole("status", { name: "Shared Memory query in the workspace index" })).toContainText("Following “workspace”");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("Memory keeps its shared-query contract at the 768px tablet boundary", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "controlled tablet acceptance uses the desktop browser context");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/#memory");
  const query = page.getByRole("searchbox", { name: "Search every memory surface" });
  await query.fill("workspace");
  const relationships = page.locator("#memory-relationships");
  await expect(relationships.getByText("Graph matches for “workspace”", { exact: true })).toBeVisible();
  const match = relationships.locator(".memory-graph-query button").first();
  await expect(match).toBeVisible();
  await match.click();
  await expect(relationships.locator(".memory-node-detail h2")).toBeVisible();
  await openMemoryIndex(page);
  await expect(page.getByRole("status", { name: "Shared Memory query in the workspace index" })).toContainText("Following “workspace”");
  // Polled past the index's own first paint: opening it inserts a results
  // region that is briefly wider than its column before the grid settles, and
  // the default 5s poll caught that frame on a loaded machine. The claim is
  // that the route settles with no overflow, not that it never has a frame with
  // any.
  await expect.poll(() => page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - innerWidth,
    mainOverflow: document.querySelector<HTMLElement>("main")!.scrollWidth - document.querySelector<HTMLElement>("main")!.clientWidth,
  })), { timeout: 20_000 }).toEqual({ documentOverflow: 0, mainOverflow: 0 });
});

test("an open Index shares one slow search authority with Recall", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single browser context owns the instrumented Memory harness");
  await page.goto("/");
  await page.evaluate(async () => {
    document.body.replaceChildren(Object.assign(document.createElement("main"), { id: "memory-authority-root" }));
    const { mountSlowMemoryAuthorityHarness } = await import("/e2e/fixtures/memory-authority-harness.tsx");
    await mountSlowMemoryAuthorityHarness(document.querySelector("#memory-authority-root")!);
  });
  const index = page.locator("#memory-index");
  await expect.poll(() => index.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
  await expect(page.getByRole("status", { name: "Shared Memory query in the workspace index" })).toBeVisible();
  await expect(page.getByLabel("Context index status")).toContainText("Searchable");
  await page.getByRole("searchbox", { name: "Search every memory surface" }).fill("workspace slow");
  await expect(page.locator("#memory-results").getByText("Searching this scope…").first()).toBeVisible();
  await expect(page.getByRole("status", { name: "Shared Memory query in the workspace index" })).toContainText("Searching");
  await expect(page.locator("#memory-results").getByText("/workspace/docs/slow.md")).toBeVisible();
  await expect(index.getByRole("heading", { name: "Search hits" }).locator("../..")).toContainText("1 in");
  await expect(index.getByRole("region", { name: "Search hits" }).getByText("docs/slow.md", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.airshipMemoryAuthorityInvocations)).toBe(1);
  await page.evaluate(() => globalThis.airshipMemoryAuthorityUpdate());
  await expect(page.locator("#memory-results").getByText("Searching this scope…").first()).toBeVisible();
  await expect(page.locator("#memory-results").getByText("workspace slow refreshed authority")).toBeVisible();
  await expect(index.getByRole("region", { name: "Search hits" })).toContainText("workspace slow refreshed authority");
  await expect.poll(() => page.evaluate(() => globalThis.airshipMemoryAuthorityInvocations)).toBe(2);
});

test("the pinned profile row switches profiles, names each one, and reaches the manager", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile information architecture");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Capabilities", exact: true })).toHaveCount(0);
  // AMENDED. The `AGENT` group was a group of exactly one destination whose
  // children duplicated the pinned profile card 300px below them, and its
  // inner 310px scroller was one of the two reasons the rail could not fit.
  // The catalog now lives in the pinned row's own menu. Nothing is lost and
  // one thing is gained: these rows never carried the profile *descriptions*,
  // and the menu does. Profiles remains reachable from `Manage profiles`, the
  // command palette and `#profiles`.
  await expect(navigation.locator("#airship-profile-navigation")).toHaveCount(0);
  const profileRow = page.locator(".sidebar .profile-switcher");
  await expect(profileRow).toBeVisible();
  /*
   * 56px was the whole pinned block when the block was one control.
   *
   * It now holds three: the profile picker (40px), "Profiles" (40px), and the
   * profile-scoped routes Skills and Capabilities (73px) — which is where those
   * two destinations went when they left the primary nav, asserted two lines
   * above. 128px is the honest measurement of what the row legitimately
   * contains.
   *
   * The claim worth keeping is not a number, it is that the pinned block stays
   * small enough for the rail to fit its global destinations: this test's own
   * comment records that an inner 310px scroller was one of the two reasons the
   * rail could not. So the picker itself is still held to one compact row, the
   * block is bounded well below that old scroller, and the rail is asserted to
   * fit rather than merely to be short.
   */
  expect(Math.round((await profileRow.locator(".menu-select").boundingBox())!.height)).toBeLessThanOrEqual(56);
  expect(Math.round((await profileRow.boundingBox())!.height)).toBeLessThanOrEqual(160);
  const railFits = await page.locator(".rail").evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(railFits).toBeLessThanOrEqual(1);
  const picker = profileRow.getByRole("button", { name: "Agent profile" });
  await picker.click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  expect(await listbox.getByRole("option").count()).toBeGreaterThan(0);
  // Every option states what the profile governs, which the rail rows did not.
  for (const option of await listbox.getByRole("option").all()) {
    await expect(option.locator("small")).not.toHaveText("");
  }
  await page.keyboard.press("Escape");
  await profileRow.getByRole("button", { name: "Manage profiles" }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await page.locator(".profile-card").filter({ hasText: "Research" }).click();
  await expect(page.locator(".profile-card.active")).toContainText("Research");
  const manager = page.getByRole("navigation", { name: "Agent configuration" });
  await manager.getByRole("button", { name: "Capabilities", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Capabilities", level: 1 })).toBeVisible();
  // AMENDED: `#capabilities` is on the shared route bar now, so its sentence is
  // the ⓘ panel's body rather than a visible paragraph. Opening the disclosure
  // and asserting the sentence verbatim is what makes that a relocation rather
  // than a deletion. See `disconnected-capabilities.spec.ts` for the full note.
  const capabilitiesAbout = page.getByRole("button", { name: /^About Capabilities\./u });
  await capabilitiesAbout.click();
  await expect(page.getByText("No inference provider is required for local activation.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await manager.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByText("Profile scope", { exact: true })).toBeVisible();
});

test("a profile catalog larger than ten never makes the rail scroll", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile rail capacity contract");
  await page.goto("/#profiles");
  const cards = page.locator(".profile-card");
  const fork = page.getByRole("button", { name: "Fork", exact: true });
  await expect(cards).toHaveCount(3);
  while (await cards.count() <= 10) {
    const before = await cards.count();
    await expect(fork).toBeEnabled();
    await fork.click();
    await expect(cards).toHaveCount(before + 1);
  }
  const expectedProfiles = await cards.count();

  // AMENDED, and strictly stronger. The old assertion bounded the in-rail
  // profile scroller at 310px so a large catalog could not push global
  // navigation off-screen — it capped the symptom. The catalog is not in the
  // rail at all now, so the invariant can be stated directly: however many
  // profiles exist, the rail itself never becomes a scroll container, and
  // every destination stays inside its painted box. The catalog is still
  // complete: one menu option per profile, counted against the route's cards.
  await page.goto("/#chat");
  await waitForShellSettled(page);
  const rail = page.locator(".primary-nav");
  const railState = await rail.evaluate((element) => ({
    overflow: element.scrollHeight - element.clientHeight,
    edges: element.dataset.scrollEdges,
  }));
  expect(railState.overflow).toBeLessThanOrEqual(1);
  expect(railState.edges).toBe("none");
  await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Agent profile" }).click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  expect(await listbox.getByRole("option").count()).toBe(expectedProfiles);
});

test("run details stay with the turn and the journal control opens its session trace", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop run-details and session-trace contract");
  await setProfilePresentationDensity(page, "Instrumented");
  await page.goto("/#chat");
  await waitForShellSettled(page);

  const prompt = "Record a local run that can be inspected from its conversation.";
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const assistant = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  const runDetails = assistant.getByRole("button", { name: /^Run details\./u });
  await expect(runDetails).toBeVisible();
  await expect(runDetails).toHaveAttribute("aria-label", /Provider airship-demo\. Run urn:receipt:/u);
  await runDetails.focus();
  await runDetails.press("Enter");
  const runPanel = assistant.getByRole("group", { name: "Run details" });
  await expect(runPanel).toBeVisible();
  await expect(runPanel.locator('[data-field="origin"]')).toContainText("Local run record");
  await expect(runPanel.locator('[data-field="created"] time')).toHaveText(/^20\d{2}-/u);
  await expect(runPanel.locator('[data-field="completed"] time')).toHaveText(/^20\d{2}-/u);
  await expect(runPanel.locator('[data-field="request-digest"] code')).toHaveText(/^sha256:/u);
  await expect(runPanel.locator('[data-field="response-digest"] code')).toHaveText(/^sha256:/u);
  await expect(runPanel.locator(".receipt-trace__scope")).toContainText("Authenticity not proven");
  const receiptId = await runPanel.locator('[data-field="receipt-id"] code').innerText();
  await runPanel.getByRole("button", { name: "Done" }).click();

  const openTrace = page.getByRole("button", { name: /Open conversation details\./u });
  await openTrace.focus();
  await openTrace.press("Enter");
  await expect(page).toHaveURL(/#sessions$/u);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();
  const journalAdapter = page.getByRole("button", {
    name: /^Current journal adapter\. Ephemeral · content not saved\./u,
  });
  await journalAdapter.click();
  const journalPanel = page.getByRole("group", { name: "Current journal adapter" });
  await expect(journalPanel).toContainText("Page-memory journal; remote availability is not inferred.");
  await expect(journalPanel).not.toContainText("Encrypted browser-managed storage on this device");
  await journalPanel.getByRole("button", { name: "Done" }).click();

  const traceToggle = page.locator(".session-integrity__row");
  await expect(traceToggle).toBeVisible();
  if (await traceToggle.getAttribute("aria-expanded") === "false") await traceToggle.click();
  await expect(traceToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Journal structure passed", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Conversation continuity" })).toContainText("Journal head");
  await expect(traceToggle).toHaveAttribute(
    "aria-label",
    /Receipt assessment: Structural linkage only · digests not recomputed · authenticity not proven\./u,
  );
  const receiptTrace = page.getByRole("region", { name: "Receipt details" });
  await expect(receiptTrace).toContainText("Structural linkage only · digests not recomputed · authenticity not proven");
  await expect(receiptTrace).toContainText(receiptId);
  await expect(receiptTrace.locator('[data-field="origin"]').first()).toContainText("Local run record");
  await expect(receiptTrace.locator('[data-field="request-digest"] code').first()).toHaveText(/^sha256:/u);
  await expect(receiptTrace.locator('[data-field="response-digest"] code').first()).toHaveText(/^sha256:/u);

  const runtimeRecord = page.locator("details.session-library-technical");
  await runtimeRecord.locator(":scope > summary").click();
  await expect(page.locator("#session-transcript-title")).toHaveText("Transcript");
  await expect(runtimeRecord.locator(".session-library-transcript")).toContainText(prompt);
});

/*
 * The Index section is reached by its own disclosure now. The scope strip that
 * used to offer a "Local index" jump restated counts the sections already carry
 * and was removed; the disclosure is the ordinary heading it always was.
 */
async function openMemoryIndex(page: Page): Promise<void> {
  /*
   * Converges on open instead of reading once and clicking once.
   *
   * This checked `open`, decided to click, and asserted the result — a
   * check-then-act race with the disclosure's own state. If it opened between
   * the read and the click, the click closed it again, and the assertion then
   * failed on a control that had done exactly what it was told twice. It failed
   * about one run in four under repetition.
   */
  const index = page.locator("#memory-index");
  const isOpen = () => index.evaluate((element: HTMLDetailsElement) => element.open);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isOpen()) return;
    await index.locator("summary").click();
    await page.waitForTimeout(150);
  }
  await expect.poll(isOpen, { timeout: 10_000 }).toBe(true);
}
