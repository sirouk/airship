import { expect, test, type Page, type TestInfo } from "@playwright/test";
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

async function openReadyApp(page: Page): Promise<void> {
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  /*
   * "Ready" has to mean past the boot reload, or it means nothing.
   *
   * All three checks above are satisfied by the document the service-worker
   * takeover is about to replace — a cold visit mints an address, reloads, and
   * mints a second, different one; see `waitForShellSettled`. Every symptom of
   * reading too early looked like a different bug: a URL round trip returning
   * the "wrong" conversation, a keystroke lost to a document with no handlers,
   * an evaluate against a destroyed context. One wait, at the one place every
   * test in this file enters.
   */
  await waitForShellSettled(page);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

async function setActiveProfileApproval(page: Page, option: "Ask First" | "Auto Approve" | "Full Access"): Promise<void> {
  await page.goto("/#profiles");
  const boundaries = page.locator("details.profile-editor-disclosure").filter({ hasText: "Profile boundaries" });
  // The boolean property, not the attribute: `getAttribute("open")` is "" for
  // a present boolean attr — which is falsy — so the gate here used to "open"
  // the disclosure it had just asked to open by toggling it shut. Profile
  // boundaries arrive open by default now, which is exactly the delta the
  // fixture tripped over.
  if (!(await boundaries.evaluate((element: HTMLDetailsElement) => element.open))) {
    await boundaries.locator("summary").click();
  }
  const picker = boundaries.getByRole("button", { name: "Profile approval policy" });
  await picker.click();
  await page.getByRole("listbox", { name: "Profile approval policy" }).getByRole("option", { name: option, exact: true }).click();
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText("Revision saved in page memory. Existing sessions remain pinned.")).toBeVisible();
  await page.getByRole("button", { name: "Switch to this profile" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator(".composer-tools")).toContainText(option);
}

test("desktop shell navigates real routes and presents a coherent session header", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop shell contract");
  /* The journal chip's typed id is telemetry: at the minimal house rung the
     chip renders only its glyph and keeps the id on its accessible name and
     tooltip, so the header this contract reads mounts at Balanced. */
  await setProfilePresentationDensity(page, "Balanced");
  await openReadyApp(page);

  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeHidden();
  await expect(page.getByRole("region", { name: "Agent session" })).toBeVisible();
  // The 15px `ACTIVE SESSION · GENERAL` band is gone as text; it is the
  // profile mark's accessible name now, which is *more* reachable than a
  // decorative eyebrow was — a screen reader hears it as part of the H1.
  await expect(page.getByRole("heading", { level: 1 }))
    .toHaveAccessibleName(/Active session · General profile/u);
  await expect(page.locator(".session-bar__title")).not.toHaveText("");
  // `Ready` and the session id were two separate 11px strings in a meta row.
  // Both survive: the lifecycle in the session-status popover, the id on the
  // journal chip, which additionally states the step count it used to omit.
  await expect(page.locator(".journal-chip__id")).toHaveText(/^#[a-z0-9-]{1,8}$/i);
  await page.locator(".session-status-chip").click();
  await expect(page.locator(".session-status-popover .popover__panel")).toContainText("Ready");
  await expect(page.locator(".session-status-popover .popover__panel"))
    .toContainText("No turn has started in this session.");
  await page.keyboard.press("Escape");
  await expect(page.locator(".session-bar").getByRole("button").first()).toBeVisible();

  // AMENDED: `All conversations` is the pinned last row of the rail's
  // conversation disclosure rather than the sixth row of a 250px scroller, in
  // which it was measured *invisible* at six or more threads. It is opened
  // before it is clicked; the destination and the hash are unchanged.
  await openRailRecents(page.getByRole("navigation", { name: "Primary" }));
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "All conversations" }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();

  // `exact` because the Workspace row now has an expander beside it whose
  // accessible name necessarily contains the destination it expands.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page).toHaveURL(/#workspace$/);
  // AMENDED (x2): `#workspace` hard-coded the heading "Editor" while the rail
  // row said Workspace. Each destination now states its own name.
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  await expect(page.getByRole("region", { name: "Agent session" })).toBeVisible();
  await capture(page, testInfo, "desktop-shell.png");
});

test("neutral topbar, session status, and run details expose current operational state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop operational-detail contract");
  await setProfilePresentationDensity(page, "Balanced");
  await openReadyApp(page);

  const topbar = page.locator(".topbar");
  await expect(topbar.getByRole("button", { name: "Open session" })).toContainText("Airship");
  await expect(topbar.getByRole("button", { name: "Connect a model", exact: true })).toBeVisible();
  await expect(topbar.locator(".topbar-destination")).toHaveText("Chat");
  await expect(topbar.locator(".runtime-line__text")).not.toHaveText("");
  const initialTopbar = await topbar.boundingBox();
  expect(initialTopbar).not.toBeNull();

  // Durability and lifecycle are conversation facts now. One status control
  // exposes both rows with the shared status-mark vocabulary.
  const sessionStatus = page.locator(".session-status-chip");
  await expect(sessionStatus).toHaveAttribute("aria-expanded", "false");
  await expect(sessionStatus.locator(".status-mark")).toHaveCount(1);
  await sessionStatus.click();
  const statusPanel = page.getByRole("group", { name: "Session status" });
  await expect(statusPanel).toBeVisible();
  await expect(statusPanel.locator(".detail-rows > *")).toHaveCount(2);
  await expect(statusPanel.locator(".detail-rows .status-mark")).toHaveCount(2);
  await expect(statusPanel).toContainText("No turn has started in this session.");

  const disclosedTopbar = await topbar.boundingBox();
  expect(disclosedTopbar).not.toBeNull();
  expect(disclosedTopbar!.height).toBe(initialTopbar!.height);

  // The disclosure returns focus to its trigger and can be opened again without
  // a pointer.
  await statusPanel.getByRole("button", { name: "Done" }).click();
  await expect(statusPanel).toBeHidden();
  await expect(sessionStatus).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(statusPanel).toBeVisible();
  const keyboardDone = statusPanel.getByRole("button", { name: "Done" });
  await keyboardDone.focus();
  await expect(keyboardDone).toBeFocused();
  await keyboardDone.press("Enter");
  await expect(statusPanel).toBeHidden();
  await expect(sessionStatus).toBeFocused();

  // Per-turn provider and identifier data lives with the answer instead of in
  // permanent shell chrome.
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Summarize this local run.");
  await page.getByRole("button", { name: "Send message" }).click();
  const response = page.locator(".message.assistant").last();
  await expect(response).toBeVisible({ timeout: 20_000 });
  const runDetails = response.getByRole("button", { name: /^Run details\. Provider /u });
  await expect(runDetails).toBeVisible({ timeout: 20_000 });
  await expect(runDetails).toContainText(/^Run · .+ · .+$/u);
  await runDetails.click();
  const runPanel = response.getByRole("group", { name: "Run details" });
  await expect(runPanel.locator('[data-field="origin"]')).toContainText(/Provider metadata|Local run record/u);
  await expect(runPanel.locator('[data-field="receipt-id"] code')).toHaveText(/^urn:receipt:/u);
  await expect(runPanel.locator(".receipt-trace__scope")).toContainText("Authenticity not proven");
});

test("the first user turn gives a new conversation a useful thread title", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop conversation naming contract");
  await openReadyApp(page);
  const prompt = "Map the browser workspace boundaries";
  await page.getByRole("combobox", { name: "Message Airship" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  // AMENDED: the list is a disclosure now. The auto-titled thread still has to
  // be in it, and it is read at 320px instead of ~105px.
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await openRailRecents(navigation);
  const recent = navigation.locator("#airship-recent-conversations");
  await expect(recent.getByRole("button", { name: new RegExp(`^${prompt}`, "u") })).toBeVisible();
});

test("rapid duplicate submit events admit only one turn for an immutable session head", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop turn-admission contract");
  await openReadyApp(page);
  const prompt = "Admit this prompt exactly once";
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill(prompt);
  await composer.evaluate((element) => {
    const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keydown", init));
  });

  const matchingTurns = page.getByRole("article", { name: "Your message" }).filter({ hasText: prompt });
  await expect(matchingTurns).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeHidden();
});

test("rapid duplicate local-command clicks admit only one slash action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop local-command admission contract");
  await openReadyApp(page);
  const prompt = "/help";
  await page.getByRole("combobox", { name: "Message Airship" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });

  const matchingCommands = page.getByRole("article", { name: "Your message" }).filter({ hasText: prompt });
  await expect(matchingCommands).toHaveCount(1);
  // The initial assistant row plus exactly one local result proves one action,
  // without pinning the transient footer wording used during projection.
  await expect(page.getByRole("article", { name: "Airship message" })).toHaveCount(2);
});

test("desktop navigation exposes profile tabs and Setup destinations with one active page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop nested navigation contract");
  await openReadyApp(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });

  // Profile configuration starts from the pinned profile row and keeps its
  // nested Skills destination keyboard-addressable.
  await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Manage profiles" }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/#skills$/);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");

  // The neutral Setup routes are Vault and Providers. Each route selects only
  // its own rail row and the topbar names the same destination.
  await navigation.getByRole("button", { name: "Vault", exact: true }).click();
  await expect(page).toHaveURL(/#vault$/);
  await expect(page.getByRole("heading", { name: "Vault", exact: true, level: 1 })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Vault", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Providers", exact: true })).not.toHaveAttribute("aria-current", "page");

  await navigation.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page).toHaveURL(/#connection$/);
  await expect(page.locator(".topbar-destination")).toHaveText("Providers");
  await expect(page.getByRole("heading", { name: "Cloud and local models", level: 2 })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Providers", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Vault", exact: true })).not.toHaveAttribute("aria-current", "page");
});

test("route form menus use the styled accessible listbox contract", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openReadyApp(page);
  const mobile = testInfo.project.name === "mobile-chromium";
  const primary = page.getByRole("navigation", { name: mobile ? "Mobile navigation" : "Primary" });

  if (mobile) {
    await primary.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "All conversations" }).click();
  } else {
    // AMENDED: opened through the conversation disclosure (see above).
    await openRailRecents(primary);
    await primary.getByRole("button", { name: "All conversations", exact: true }).click();
  }
  // AMENDED: below 640px the four session filters are a counted disclosure
  // rather than a row that scrolled three of them off the right edge of a
  // phone with no scrollbar, no fade and nothing saying they existed
  // (`sessions-view.tsx:298`). Reaching the menu through that trigger is a
  // stronger assertion than the old direct click: the filters must still be
  // reachable on a phone AND the trigger must say how many are set, so a
  // collapsed filter can never be a silent one. Above 640px the trigger is
  // hidden and the row is the resting layout, unchanged.
  // The toolbar gate is load-bearing: `isVisible()` does not auto-wait, so
  // probing the trigger before the lazy route mounts always answers "no" and
  // silently skips the disclosure this amendment exists to drive.
  const sessionToolbar = page.getByRole("search", { name: "Filter conversations" });
  await expect(sessionToolbar).toBeVisible();
  const filterDisclosure = sessionToolbar.getByRole("button", { name: /^Filters(?: · \d+)?$/u });
  if (await filterDisclosure.isVisible()) {
    await expect(filterDisclosure).toHaveAttribute("aria-expanded", "false");
    await filterDisclosure.click();
    await expect(filterDisclosure).toHaveAttribute("aria-expanded", "true");
  }
  const provider = page.getByRole("button", { name: "Filter by provider" });
  await provider.click();
  const providerList = page.getByRole("listbox", { name: "Filter by provider" });
  await expect(providerList).toBeVisible();
  // AMENDED: measured on the menu's own painted surface rather than on the
  // `listbox` node, because those stopped being the same box when `MenuSelect`
  // took the bottom-sheet contract. A sheet has a header naming the control it
  // belongs to and a `Done` button, and neither is an option — so `role=
  // listbox` moved onto an inner `.menu-select-list` that owns nothing but the
  // options, which is what the role promises. The panel kept the background,
  // the positioning and the box.
  //
  // Reached with `closest` from the listbox rather than by naming a second
  // selector: the assertion is "the menu this listbox is rendered in is
  // painted, positioned and on the screen", and resolving it through the
  // element under test keeps that true if the nesting changes again. The
  // fallback to the element itself is what keeps this honest for any menu that
  // is still its own panel.
  const providerMenuStyle = await providerList.evaluate((element) => {
    const panel = element.closest(".menu-select-popover") ?? element;
    const style = getComputedStyle(panel);
    const box = panel.getBoundingClientRect();
    return { background: style.backgroundColor, position: style.position, left: box.left, right: box.right, viewport: innerWidth };
  });
  expect(providerMenuStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(["absolute", "fixed"]).toContain(providerMenuStyle.position);
  expect(providerMenuStyle.left).toBeGreaterThanOrEqual(0);
  expect(providerMenuStyle.right).toBeLessThanOrEqual(providerMenuStyle.viewport + 1);
  if (!mobile) {
    const triggerBox = await provider.boundingBox();
    // The same panel, for the same reason: "the menu hangs below its trigger"
    // measures the box that is positioned; an inner options list sits inside
    // whatever padding that box carries.
    const listBox = await providerList.evaluate((element) => {
      const panel = element.closest(".menu-select-popover") ?? element;
      const box = panel.getBoundingClientRect();
      return { y: box.y };
    });
    expect(triggerBox).not.toBeNull();
    expect(listBox.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height - 1);
  }
  await providerList.getByRole("option", { name: "airship-demo" }).click();
  await expect(provider).toContainText("airship-demo");

  if (mobile) {
    await primary.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "Profiles" }).first().click();
  } else {
    // AMENDED: `Profiles` is no longer a resting rail row; it is the pinned
    // profile row's `Manage profiles`, the same reach this file's gutter test
    // already uses (line 381) and the route audit asserts. Driving the real
    // affordance is stronger than the retired one — a missing profile switcher
    // now fails here rather than passing against a row that no longer exists.
    await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Manage profiles" }).click();
  }
  await page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true }).click();
  // AMENDED: reaching Profiles through `Manage profiles` scopes the hub to the
  // active profile (`openProfileManager(profileId)`), and `Preview profile
  // resolution` renders only in the `All profiles` scope. Widening the scope
  // through the `Skill scope` menu restores the original control *and* adds
  // one: the test now drives two styled listboxes on this surface instead of
  // one, and the second is reached by an option chosen in the first, so a menu
  // that renders but does not commit its selection fails here.
  const scope = page.getByRole("button", { name: "Skill scope" });
  await scope.click();
  await page.getByRole("listbox", { name: "Skill scope" }).getByRole("option", { name: "All profiles", exact: true }).click();
  await expect(scope).toContainText("All profiles");
  const profile = page.getByRole("button", { name: "Preview profile resolution" });
  await profile.click();
  const profileList = page.getByRole("listbox", { name: "Preview profile resolution" });
  const alternateProfile = profileList.locator("[role='option'][aria-selected='false']");
  await alternateProfile.first().click();
  await expect(profile).not.toContainText("General");

  if (mobile) {
    await primary.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "Editor" }).first().click();
  } else {
    // AMENDED: `Editor` now sits behind the rail's Workspace expander. The
    // expander is asserted rather than optional here, so a Workspace group that
    // stopped disclosing its destinations fails instead of silently skipping.
    const expander = primary.getByRole("button", { name: "Expand Workspace" });
    if (await expander.count()) await expander.click();
    await primary.getByRole("button", { name: "Editor", exact: true }).click();
  }
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: "Advanced source controls" }).click();
  await expect(page.getByRole("dialog", { name: "Advanced source controls" })).toBeVisible();
  // AMENDED: the branch/worktree/checkout controls rest inside a `<details>`
  // that opens itself only once a repository has more than one worktree
  // (`sources-view.tsx:533`), so on a single-worktree workspace the Repository
  // menu is one disclosure deep. Asserting the summary still names what it
  // holds before opening it is stronger than the old bare click: it now fails
  // if the controls become reachable only through an unlabelled affordance.
  const repositoryControls = page.locator("details.git-repository-controls");
  await expect(repositoryControls.locator("summary")).toContainText(/worktree/u);
  await expect(repositoryControls.locator("summary")).toContainText(/branch, worktree and checkout controls/u);
  // The live `open` property, not the attribute: `getAttribute("open")` answers
  // "" on an open `<details>`, which is falsy, so an attribute test would click
  // an already-open disclosure shut.
  if (!(await repositoryControls.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await repositoryControls.locator("summary").click();
  }
  await expect(repositoryControls).toHaveJSProperty("open", true);
  const repository = page.getByRole("button", { name: "Repository" });
  await repository.click();
  await expect(page.getByRole("listbox", { name: "Repository" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("styled-route-menu.png"), fullPage: !mobile });
});

test("mobile shell keeps primary destinations usable and exposes additional routes through More", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile shell contract");
  await openReadyApp(page);

  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(mobileNavigation).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();

  await mobileNavigation.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "All conversations" }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();

  await mobileNavigation.getByRole("button", { name: "Workspace" }).click();
  await expect(page).toHaveURL(/#workspace$/);
  // AMENDED (x2): `#workspace` hard-coded the heading "Editor" while the rail
  // row said Workspace. Each destination now states its own name.
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();

  await mobileNavigation.getByRole("button", { name: "More" }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await expect(more).toBeVisible();
  await more.getByRole("button", { name: /Memory/ }).click();
  await expect(page).toHaveURL(/#memory$/);
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Chat" }).click();
  await expect(page.getByRole("region", { name: "Agent session" })).toBeVisible();
  await capture(page, testInfo, "mobile-shell.png");
});

test("command palette keeps composite focus on its search field and restores its opener", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop command palette keyboard contract");
  await openReadyApp(page);

  const opener = page.getByRole("button", { name: "Open command palette" });
  await opener.focus();
  await opener.press("Enter");

  let palette = page.getByRole("dialog", { name: "Airship command palette" });
  let search = palette.getByRole("combobox");
  const close = palette.getByRole("button", { name: "Close command palette" });
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-autocomplete", "list");
  expect(await palette.getByRole("option").evaluateAll((options) => options.filter((option) => option.tabIndex >= 0).length)).toBe(0);

  // Results belong to the combobox's active-descendant model, so Tab reaches
  // the dialog's real dismissal control instead of walking dozens of options.
  await search.press("Tab");
  await expect(close).toBeFocused();
  await close.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  palette = page.getByRole("dialog", { name: "Airship command palette" });
  search = palette.getByRole("combobox");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  palette = page.getByRole("dialog", { name: "Airship command palette" });
  search = palette.getByRole("combobox");
  await expect(search).toBeFocused();
  await search.fill("no-command-can-match-this-query");
  await expect(palette.getByRole("status")).toHaveText("No matching destination or command.");
  await expect(search).toBeFocused();
  await search.fill("Memory");
  await expect(search).toHaveAttribute("aria-activedescendant", "palette-view-memory");
  await search.press("ArrowDown");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-activedescendant", "palette-view-context");
  await expect(palette.getByRole("option", { name: /^Memory index/u })).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(page).toHaveURL(/#context$/u);
});

test("mobile Command Center has an explicit touch dismissal and returns to More", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile command palette contract");
  await openReadyApp(page);

  const more = page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More", exact: true });
  await more.click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: /^Command Center/u }).click();

  const palette = page.getByRole("dialog", { name: "Airship command palette" });
  const close = palette.getByRole("button", { name: "Close command palette" });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);

  await close.click();
  await expect(palette).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("profile-owned approval policy clearly switches new pinned conversations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop settings contract");
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("airship-approval-test-seeded")) return;
    sessionStorage.setItem("airship-approval-test-seeded", "1");
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  });
  await openReadyApp(page);

  await expect(page.locator(".composer-tools")).toContainText("Ask First");
  await page.getByRole("combobox", { name: "Message Airship" }).fill("/write approvals/ask.txt pending");
  await page.getByRole("button", { name: "Send message" }).click();
  const askDecision = page.getByRole("dialog", { name: /Allow write_file once/ });
  await expect(askDecision).toBeVisible();
  await askDecision.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();

  await page.getByRole("button", { name: "Open Preferences" }).click();
  const preferences = page.getByRole("dialog", { name: "Preferences" });
  await expect(preferences.getByText("Active profile approvals", { exact: true })).toBeVisible();
  await expect(preferences.getByText("Ask First", { exact: true })).toBeVisible();
  await preferences.getByRole("button", { name: "Manage in Profiles" }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await setActiveProfileApproval(page, "Auto Approve");

  /*
   * The same visible decision, for a better reason than it used to be. This
   * once passed because the demo model could not produce the strict structured
   * verdict, so Auto Approve fell back to a human — which meant a real reviewer
   * model would have taken this decision instead, and an `unsafe` verdict would
   * have denied the operator's own typed command outright.
   *
   * A slash command is proposed by the person, so it is now adjudicated by
   * `createHumanIntentPolicy`: Auto Approve asks, unconditionally and without a
   * reviewer. The dialog below is therefore the contract, not an artefact of
   * which model happens to be loaded.
   */
  await page.getByRole("combobox", { name: "Message Airship" }).fill("/write approvals/auto.txt reviewed");
  await page.getByRole("button", { name: "Send message" }).click();
  const autoDecision = page.getByRole("dialog", { name: /Allow write_file once/ });
  await expect(autoDecision).toBeVisible();
  await autoDecision.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();
  // No local command's parameters reach a model before it runs, in any mode, so
  // the denial no longer names a safety review that happened.
  await expect(page.getByText(/nothing was sent to the model/u).last()).toBeVisible();

  await setActiveProfileApproval(page, "Full Access");

  await page.getByRole("combobox", { name: "Message Airship" }).fill("/write approvals/full.txt bounded");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Local result · excluded from model context").last()).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Allow write_file once/ })).toHaveCount(0);

  await setActiveProfileApproval(page, "Ask First");
  await page.screenshot({ path: testInfo.outputPath("approval-mode-menu.png"), fullPage: true });
});

test("the composer changes approval policy in place on the conversation being read", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop composer approval contract");
  await openReadyApp(page);
  // The control governs the conversation being read, so there must be one:
  // a message first, then the keyboard path through the same select.
  await page.getByRole("combobox", { name: "Message Airship" }).fill("approval in place check");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/, { timeout: 20_000 });
  await expect(page.locator(".transcript")).toContainText("in place check", { timeout: 20_000 });
  const conversationUrl = page.url();

  const picker = page.getByRole("button", { name: "Conversation approval policy" });
  await expect(picker).toContainText("Ask First");
  await picker.focus();
  await picker.press("ArrowDown");
  await page
    .getByRole("listbox", { name: "Conversation approval policy" })
    .getByRole("option", { name: "Auto Approve", exact: true })
    .click();
  await expect(picker).toContainText("Auto Approve");
  // In place, on the thread being read: the address and the conversation do
  // not move, and the sentence explains the exact scope of what changed.
  expect(page.url()).toBe(conversationUrl);
  /* One sentence, two carriers: the topbar runtime line and its phone-shell
     twin both exist in the DOM at every width and hold the same text, so the
     check is about one visible carrier — the topbar's comes first in DOM
     order at this width. */
  await expect(page.locator(".runtime-line__text").filter({ hasText: /Approval policy changed to Auto Approve for this conversation/u }).first()).toBeVisible({ timeout: 15_000 });
});

test("desktop profile menu restores each profile's conversation cockpit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile contract");
  await openReadyApp(page);
  const profile = page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" });
  await expect(profile).toContainText("General");
  const generalUrl = page.url();
  await profile.click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  await listbox.getByRole("option", { name: /Research/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(/Research profile/u);
  await expect(page.locator(".session-bar__title")).toContainText("Research");
  await expect(profile).toContainText("Research");
  await expect(listbox).toBeHidden();

  const researchUrl = page.url();
  expect(researchUrl).not.toBe(generalUrl);
  await page.locator(".session-bar__identity-button").dblclick();
  const title = page.getByRole("textbox", { name: "Conversation title" });
  await title.fill("Research cockpit checkpoint");
  await page.getByRole("combobox", { name: "Message Airship" }).click();
  await expect(page.locator(".session-bar__title")).toHaveText("Research cockpit checkpoint");

  await profile.click();
  await listbox.getByRole("option", { name: /General/ }).click();
  await expect(page).toHaveURL(generalUrl);
  await expect(profile).toContainText("General");

  await profile.click();
  await listbox.getByRole("option", { name: /Research/ }).click();
  await expect(profile).toContainText("Research");
  await expect(page).toHaveURL(researchUrl);
  await expect(page.locator(".session-bar__title")).toHaveText("Research cockpit checkpoint");
  await page.screenshot({ path: testInfo.outputPath("profile-switched.png"), fullPage: true });
});

test("route gutter and density preferences apply consistently to the whole layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop layout contract");
  await openReadyApp(page);
  const comfortableHeader = await page.locator(".session-bar").boundingBox();
  const comfortableFont = await page.locator("html").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(comfortableHeader).not.toBeNull();
  expect(comfortableFont).toBeGreaterThanOrEqual(17);

  const offsets: number[] = [];
  // AMENDED only in how two of the three routes are reached: `All
  // conversations` is the last row of the rail's conversation disclosure, and
  // `Profiles` is the pinned profile row's `Manage profiles`. The three routes
  // measured, and every gutter assertion below, are unchanged.
  const primaryNav = page.getByRole("navigation", { name: "Primary" });
  const openRoute: Readonly<Record<string, () => Promise<void>>> = {
    "All conversations": async () => {
      await openRailRecents(primaryNav);
      await primaryNav.getByRole("button", { name: "All conversations", exact: true }).click();
    },
    Workspace: async () => { await primaryNav.getByRole("button", { name: "Workspace", exact: true }).click(); },
    Profiles: async () => { await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Manage profiles" }).click(); },
  };
  for (const route of ["All conversations", "Workspace", "Profiles"] as const) {
    await openRoute[route]!();
    // Two separate `boundingBox()` calls race the lazy route swap: the outgoing
    // route's H1 can satisfy the first and be detached by the second, and
    // `boundingBox()` does not retry a null. One evaluate measures both boxes
    // against the same frame. The gutter assertions below are unchanged.
    const heading = page.locator("main.main h1");
    await expect(heading).toBeVisible();
    // AMENDED: this measurement was a false green. Every lazy route ships a
    // loading placeholder that renders the route's own `<h1>` inside a
    // `.page-heading` — same text, different primitive — so `toBeVisible()` was
    // satisfied by the skeleton and the gutter recorded was the skeleton's.
    // `#sessions` measured 27px that way while its loaded `<RouteHeader>` sat
    // at 58px, and the assertion below could not fail. Waiting for the skeleton
    // to leave is what makes this a test: it now measures the primitive the
    // user actually reads.
    await expect(page.locator("main.main .route-loading")).toHaveCount(0);
    const offset = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main.main")?.getBoundingClientRect();
      const title = document.querySelector<HTMLElement>("main.main h1")?.getBoundingClientRect();
      return main && title ? title.x - main.x : undefined;
    });
    expect(offset).toBeDefined();
    offsets.push(offset!);
  }
  expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1);
  expect(offsets[0]).toBeGreaterThanOrEqual(14);

  await primaryNav.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Open Preferences" }).click();
  const density = page.getByRole("dialog", { name: "Preferences" }).getByLabel("Density");
  await density.click();
  await page.getByRole("listbox", { name: "Density" }).getByRole("option", { name: "Compact" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  const compactFont = await page.locator("html").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await page.getByRole("dialog", { name: "Preferences" }).getByRole("button", { name: "Done" }).click();
  const compactHeader = await page.locator(".session-bar").boundingBox();
  expect(compactHeader).not.toBeNull();
  expect(compactFont).toBeLessThan(comfortableFont);
  expect(compactHeader!.height).toBeLessThan(comfortableHeader!.height);
  await page.screenshot({ path: testInfo.outputPath("compact-layout.png"), fullPage: true });
});

test("mobile session controls stay within the header and profile switching remains usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile profile and geometry contract");
  await openReadyApp(page);

  const sessionDetails = page.locator(".session-status-chip");
  await expect(sessionDetails).toBeVisible();
  const stage = await page.locator(".session-bar").boundingBox();
  const details = await page.locator(".session-bar__chips").boundingBox();
  expect(stage).not.toBeNull();
  expect(details).not.toBeNull();
  await expect(sessionDetails).toHaveAccessibleName(/Session\. Ephemeral · content not saved\..*2 details\./u);
  const restingMark = sessionDetails.locator(".status-mark");
  await expect(restingMark).toHaveCount(1);
  await expect(restingMark).toHaveAttribute("data-state", "attention");

  await sessionDetails.click();
  const sessionState = page.getByRole("group", { name: "Session status" });
  await expect(sessionState).toContainText("Ephemeral · content not saved");
  await expect(sessionState).toContainText("This session journal exists only in page memory. Nothing is synced.");
  await expect(sessionState.locator(".detail-rows > *")).toHaveCount(2);
  await expect(sessionState.locator(".detail-rows .status-mark")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(sessionState).toBeHidden();
  expect(details!.x).toBeGreaterThanOrEqual(stage!.x);
  expect(details!.x + details!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  expect(details!.y).toBeGreaterThanOrEqual(stage!.y);
  expect(details!.y + details!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);

  const profile = page.locator(".compact-profile-menu").getByRole("button", { name: "Agent profile" });
  await profile.click();
  await page.getByRole("listbox", { name: "Agent profile" }).getByRole("option", { name: /Developer/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(/Developer profile/u);
  await expect(profile.locator(".profile-monogram")).toHaveText("DE");
  await page.screenshot({ path: testInfo.outputPath("mobile-header-profile.png"), fullPage: true });
});
