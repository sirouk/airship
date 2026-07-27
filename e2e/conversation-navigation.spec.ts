import { expect, test } from "@playwright/test";

test("every conversation has a stable addressed URL and new conversations do not overwrite it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop addressed conversation contract");
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const firstUrl = page.url();

  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await expect.poll(() => page.url()).not.toBe(firstUrl);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);

  const firstConversation = page
    .getByRole("navigation", { name: "Primary" })
    .locator("#airship-recent-conversations .recent-conversation:not(.active)")
    .first();
  if (await firstConversation.count()) {
    await firstConversation.click();
    await expect(page).toHaveURL(firstUrl);
  }
});

test("conversation branches preserve their source and navigate back through lineage", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop immutable branch contract");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const sourceUrl = page.url();
  // Forked from a real turn rather than from the welcome card. That card is
  // gone: it attributed a speaker for a message no model produced and offered
  // Retry and Branch on it, neither of which had a referent. Branching a turn
  // that actually happened is the stronger version of this contract.
  const seedComposer = page.getByRole("combobox", { name: "Message Airship" });
  await seedComposer.fill("/help");
  await page.getByRole("button", { name: "Send message" }).click();
  const message = page.locator("[data-transcript-card]").first();
  const restoredPrompt = (await message.locator(".message-body > p").textContent())?.trim();
  expect(restoredPrompt).toBeTruthy();
  await message.hover();
  const fork = message.getByRole("button", { name: "Fork conversation" });
  await expect(fork).toBeEnabled();
  await fork.click();
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toHaveValue(restoredPrompt!);
  // Cross the draft debounce and the route-request → active-session
  // normalization. Neither is allowed to erase the intentional fork prefill.
  await page.waitForTimeout(240);
  await expect(composer).toHaveValue(restoredPrompt!);
  const lineage = page.getByRole("button", { name: /Branch from #/u });
  await expect(lineage).toBeVisible();
  await lineage.click();
  await expect(page).toHaveURL(sourceUrl);
});

test("each addressed conversation restores its own unsent draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop conversation draft contract");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const sourceUrl = page.url();
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("An unsent source-conversation draft");
  await page.waitForTimeout(220);
  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  await expect(composer).toHaveValue("");

  const source = page
    .getByRole("navigation", { name: "Primary" })
    .locator("#airship-recent-conversations .recent-conversation:not(.active)")
    .first();
  await source.click();
  await expect(page).toHaveURL(sourceUrl);
  await expect(composer).toHaveValue("An unsent source-conversation draft");
});

test("an addressed draft survives a full page reload before session resume", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop reload draft contract");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const addressedUrl = page.url();
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("Restore this addressed draft after reload");
  await page.waitForTimeout(220);

  await page.reload();

  await expect(page).toHaveURL(addressedUrl);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(composer).toHaveValue("Restore this addressed draft after reload");
});

test("desktop treats Chat as the conversation disclosure and preserves the full ledger", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop conversation information architecture");
  await page.goto("/#chat");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Sessions", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");

  const disclosure = navigation.getByRole("button", { name: "Collapse recent conversations" });
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const recent = navigation.locator("#airship-recent-conversations");
  await expect(recent).toBeVisible();
  expect(await recent.locator(".recent-conversation").count()).toBeLessThanOrEqual(10);
  await disclosure.click();
  await expect(navigation.locator("#airship-recent-conversations")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Expand recent conversations" })).toHaveAttribute("aria-expanded", "false");
  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  await navigation.getByRole("button", { name: "Expand recent conversations" }).click();
  await navigation.getByRole("button", { name: "All conversations", exact: true }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();

  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  // `.session-id` and its "20 recorded steps" sibling are one journal chip
  // now: same target, same destination, and the count is no longer a
  // separate string beside the id.
  await page.locator(".journal-chip__record").click();
  await expect(page).toHaveURL(/#sessions$/);
});

test("mobile keeps conversations out of the fixed bar and exposes the ledger through More", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile conversation information architecture");
  await page.goto("/#chat");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const originalConversation = page.url();
  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await expect.poll(() => page.url()).not.toBe(originalConversation);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(navigation.getByRole("button", { name: "Sessions", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button")).toHaveCount(4);
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
  await expect(page.getByRole("tab", { name: "Files & editor" })).toHaveAttribute("aria-selected", "true");
  await navigation.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page).toHaveURL(/#terminal$/);
});

test("Editor source tools default to a collapsible tree and Profiles archives without stranding history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop management information architecture");
  await page.goto("/#editor");
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
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
  await query.fill("workspace");
  await expect(relationships.getByText("Graph matches for “workspace”", { exact: true })).toBeVisible();
  await expect(page.locator("#memory-results").getByRole("status")).toContainText(/Searching|current/u);
  const index = page.locator("#memory-index");
  await expect.poll(() => index.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  await index.locator("summary").click();
  await expect(page.getByRole("search", { name: "Shared Memory query in the workspace index" })).toContainText("Following “workspace”");

  await page.goto("/#context");
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
  const deepLinkedIndex = page.locator("#memory-index");
  await expect.poll(() => deepLinkedIndex.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
  await expect(page.getByLabel("Context index status")).toBeVisible();
  await expect.poll(() => page.locator("main").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => deepLinkedIndex.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topbar = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
    return bounds.top >= (topbar?.bottom ?? 0) - 1 && bounds.top <= (topbar?.bottom ?? 0) + 32;
  })).toBe(true);
});

test("Memory disclosures and graph stay inside the mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile memory overflow contract");
  await page.goto("/#memory");
  await page.getByRole("searchbox", { name: "Search every memory surface" }).fill("workspace");
  await expect(page.locator("#memory-relationships")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const jumpNavigation = page.getByRole("navigation", { name: "Memory page sections" });
  const overflow = await jumpNavigation.evaluate((element) => ({
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.overflowX).toBe("auto");
  expect(overflow.scrollWidth).toBeGreaterThanOrEqual(overflow.clientWidth);
  const graph = page.getByLabel("Interactive memory relationship graph");
  await expect(graph).toBeVisible();
  const graphBounds = await graph.boundingBox();
  expect(graphBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((graphBounds?.x ?? 0) + (graphBounds?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual((await page.evaluate(() => window.innerWidth)) + 1);
  const match = page.locator("#memory-relationships .memory-graph-query button").first();
  await expect(match).toBeVisible();
  await match.click();
  await expect(page.locator("#memory-relationships .memory-node-detail h2")).toBeVisible();
  await page.getByRole("button", { name: /Local index/u }).click();
  await expect(page.getByRole("search", { name: "Shared Memory query in the workspace index" })).toContainText("Following “workspace”");
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
  await page.getByRole("button", { name: /Local index/u }).click();
  await expect(page.getByRole("search", { name: "Shared Memory query in the workspace index" })).toContainText("Following “workspace”");
  await expect.poll(() => page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - innerWidth,
    mainOverflow: document.querySelector<HTMLElement>("main")!.scrollWidth - document.querySelector<HTMLElement>("main")!.clientWidth,
  }))).toEqual({ documentOverflow: 0, mainOverflow: 0 });
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
  await expect(page.getByRole("search", { name: "Shared Memory query in the workspace index" })).toBeVisible();
  await expect(page.getByLabel("Context index status")).toContainText("Searchable");
  await page.getByRole("searchbox", { name: "Search every memory surface" }).fill("workspace slow");
  await expect(page.locator("#memory-results").getByText("Searching this scope…").first()).toBeVisible();
  await expect(page.getByRole("search", { name: "Shared Memory query in the workspace index" })).toContainText("Searching");
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

test("Profiles opens by default, remains collapsible, and uses one scoped tabbed manager", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile information architecture");
  await page.goto("/#chat");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Capabilities", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Collapse profiles" })).toHaveAttribute("aria-expanded", "true");
  const profileList = navigation.locator("#airship-profile-navigation");
  await expect(profileList).toBeVisible();
  expect(await profileList.locator(".recent-conversation").count()).toBeGreaterThan(0);
  const profileRailStyle = await profileList.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    maxHeight: getComputedStyle(element).maxHeight,
  }));
  expect(profileRailStyle.overflowY).toBe("auto");
  expect(profileRailStyle.maxHeight).toContain("310px");
  await navigation.getByRole("button", { name: "Collapse profiles" }).click();
  await expect(profileList).toHaveCount(0);
  await navigation.getByRole("button", { name: "Profiles", exact: true }).click();
  await expect(navigation.getByRole("button", { name: "Collapse profiles" })).toHaveAttribute("aria-expanded", "true");
  const reopenedProfileList = navigation.locator("#airship-profile-navigation");
  await reopenedProfileList.getByRole("button", { name: /Research/u }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await expect(page.locator(".profile-card.active")).toContainText("Research");
  const manager = page.getByRole("navigation", { name: "Agent configuration" });
  await manager.getByRole("button", { name: "Capabilities", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Capabilities", level: 1 })).toBeVisible();
  await expect(page.getByText(/No inference provider.*is required for local activation/u)).toBeVisible();
  await manager.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByText("Profile scope", { exact: true })).toBeVisible();
});

test("Profiles keeps catalogs larger than ten inside a ten-row scrolling rail", async ({ page }, testInfo) => {
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

  const profileList = page.getByRole("navigation", { name: "Primary" }).locator("#airship-profile-navigation");
  await expect(profileList.locator(".recent-conversation")).toHaveCount(await cards.count());
  const dimensions = await profileList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.clientHeight).toBeLessThanOrEqual(310);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
});

test("Proof owns receipt, journal, and attestation evidence without a duplicate destination", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop unified proof information architecture");
  await page.goto("/#proof");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Attestations", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Receipt & journal" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Attestation evidence" }).click();
  await expect(page).toHaveURL(/#proof\?section=attestations$/);
  await expect(page.getByRole("heading", { name: "Endpoint & receipt evidence", level: 2 })).toBeVisible();
  await page.getByRole("tab", { name: "Attestation evidence" }).press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Receipt & journal" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Session journal integrity", level: 2 })).toBeVisible();
});
