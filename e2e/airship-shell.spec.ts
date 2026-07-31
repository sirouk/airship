import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function openReadyApp(page: Page): Promise<void> {
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Expand recent conversations" }).click();
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

test("compact runtime indicators disclose scoped detail without expanding the topbar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop indicator disclosure contract");
  await openReadyApp(page);

  // Four axis pills — the fourth truncated to `Secure hardware not c…` — are
  // one chip that states the weakest claim in full and counts the rest. The
  // detail sentence used to exist only in a `role="tooltip"` a touch user could
  // never open; it is now a row in the sheet the chip opens, which is a
  // stronger disclosure than the one this test was written to protect.
  const runtime = page.locator(".topbar-posture-chip");
  await expect(runtime).toContainText("Browser / Edge runtime");
  await expect(runtime).toContainText("4 axes");
  const initialTopbar = await page.locator(".topbar").boundingBox();
  expect(initialTopbar).not.toBeNull();
  await runtime.click();
  const sheet = page.getByRole("dialog", { name: "Runtime trust" });
  await expect(sheet).toContainText("The agent kernel executes in this browser.");
  // The chip says four; the sheet must render four. The count is the chip's
  // statement of its own cost, so it may not drift from what it hides.
  await expect(sheet.locator(".claim-rows > button")).toHaveCount(4);
  const disclosedTopbar = await page.locator(".topbar").boundingBox();
  expect(disclosedTopbar).not.toBeNull();
  expect(disclosedTopbar!.height).toBe(initialTopbar!.height);

  // The sheet is the disclosure, so it must be dismissible and re-openable by
  // keyboard alone — the tooltip it replaces was hover-only and unreachable.
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
  await runtime.focus();
  await expect(runtime).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Runtime trust" })).toBeVisible();
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
  await navigation.getByRole("button", { name: "Expand recent conversations" }).click();
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
  await page.getByRole("button", { name: "Send message" }).evaluate((element) => {
    const init = { bubbles: true, cancelable: true };
    element.dispatchEvent(new MouseEvent("click", init));
    element.dispatchEvent(new MouseEvent("click", init));
  });

  await expect(page.getByText("Local command · excluded from model context").last()).toBeVisible();
  const matchingCommands = page.getByRole("article", { name: "Your message" }).filter({ hasText: prompt });
  await expect(matchingCommands).toHaveCount(1);
});

test("desktop navigation exposes profile tabs and Account with one active page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop nested navigation contract");
  await openReadyApp(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });

  // AMENDED: the `AGENT` group of one is dissolved. The pinned profile row's
  // `Manage profiles` control opens the manager *scoped to the pinned
  // profile*, which is a scope the rail's Profiles row never carried.
  await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Manage profiles" }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/#skills$/);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");

  await navigation.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page).toHaveURL(/#account$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true, level: 1 })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Account", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Connection", exact: true })).not.toHaveAttribute("aria-current", "page");
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
    await primary.getByRole("button", { name: "Expand recent conversations" }).click();
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
  const providerMenuStyle = await providerList.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return { background: style.backgroundColor, position: style.position, left: box.left, right: box.right, viewport: innerWidth };
  });
  expect(providerMenuStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(["absolute", "fixed"]).toContain(providerMenuStyle.position);
  expect(providerMenuStyle.left).toBeGreaterThanOrEqual(0);
  expect(providerMenuStyle.right).toBeLessThanOrEqual(providerMenuStyle.viewport + 1);
  if (!mobile) {
    const triggerBox = await provider.boundingBox();
    const listBox = await providerList.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(listBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height - 1);
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

test("the composer changes approval policy in place through a new immutable conversation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop composer approval contract");
  await openReadyApp(page);
  const initialUrl = page.url();
  const picker = page.getByRole("button", { name: "Conversation approval policy" });
  await expect(picker).toContainText("Ask First");
  await picker.focus();
  await picker.press("ArrowDown");
  await page
    .getByRole("listbox", { name: "Conversation approval policy" })
    .getByRole("option", { name: "Auto Approve", exact: true })
    .click();
  await expect(picker).toContainText("Auto Approve");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  expect(page.url()).not.toBe(initialUrl);
  await expect(page.getByText(/Approval policy changed to Auto Approve/u)).toBeVisible();
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
      await primaryNav.getByRole("button", { name: "Expand recent conversations" }).click();
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

test("mobile session header groups wrap without overlap and profile switching remains usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile profile and geometry contract");
  await openReadyApp(page);
  // `.mobile-session-details` was a third rendering of a pair the desktop meta
  // row and the topbar already showed, and it stacked two seal glyphs to do it.
  // One chip renders one glyph; the durability sentence it kept in a `title` is
  // visible body text in its popover for the first time.
  const sessionDetails = page.locator(".session-status-chip");
  await expect(sessionDetails).toBeVisible();
  const stage = await page.locator(".session-bar").boundingBox();
  const details = await page.locator(".session-bar__chips").boundingBox();
  expect(stage).not.toBeNull();
  expect(details).not.toBeNull();
  await expect(sessionDetails).toHaveAccessibleName(/Session\. Ephemeral · this page only\./u);
  await expect(sessionDetails.locator(".seal")).toHaveCount(1);
  await sessionDetails.click();
  const sessionState = page.locator(".session-status-popover .popover__panel");
  await expect(sessionState).toContainText("Ephemeral · this page only");
  await expect(sessionState).toContainText("This session journal exists only in page memory. Nothing is synced.");
  await page.keyboard.press("Escape");
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
