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
  if (!(await boundaries.getAttribute("open"))) await boundaries.locator("summary").click();
  const picker = boundaries.getByRole("button", { name: "Profile approval policy" });
  await picker.click();
  await page.getByRole("listbox", { name: "Profile approval policy" }).getByRole("option", { name: option, exact: true }).click();
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText("Revision saved in page memory. Existing sessions remain pinned.")).toBeVisible();
  await page.getByRole("button", { name: "Apply in a new session" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator(".composer-tools")).toContainText(option);
}

test("desktop shell navigates real routes and presents a coherent session header", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop shell contract");
  await openReadyApp(page);

  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeHidden();
  await expect(page.getByRole("region", { name: "Agent session" })).toBeVisible();
  await expect(page.locator(".stage-header .eyebrow")).toContainText("Active session");
  await expect(page.locator(".stage-header h1")).not.toHaveText("");
  await expect(page.locator(".session-lifecycle")).toContainText("Ready");
  await expect(page.locator(".session-id")).toHaveText(/^#[a-z0-9-]{1,8}$/i);
  await expect(page.locator(".stage-header").getByRole("button").first()).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "All conversations" }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace" }).click();
  await expect(page).toHaveURL(/#workspace$/);
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  await expect(page.getByRole("region", { name: "Agent session" })).toBeVisible();
  await capture(page, testInfo, "desktop-shell.png");
});

test("compact runtime indicators disclose scoped detail without expanding the topbar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop indicator disclosure contract");
  await openReadyApp(page);

  const runtime = page.locator(".topbar-center .status-seal").filter({ hasText: "Browser / Edge runtime" });
  const initialTopbar = await page.locator(".topbar").boundingBox();
  expect(initialTopbar).not.toBeNull();
  await runtime.hover();
  const detail = runtime.getByRole("tooltip");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("agent kernel is executing in this browser");
  const disclosedTopbar = await page.locator(".topbar").boundingBox();
  expect(disclosedTopbar).not.toBeNull();
  expect(disclosedTopbar!.height).toBe(initialTopbar!.height);

  await runtime.focus();
  await expect(detail).toBeVisible();
});

test("the first user turn gives a new conversation a useful thread title", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop conversation naming contract");
  await openReadyApp(page);
  const prompt = "Map the browser workspace boundaries";
  await page.getByRole("combobox", { name: "Message Airship" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const recent = page.getByRole("navigation", { name: "Primary" }).locator("#airship-recent-conversations");
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

  await navigation.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/#skills$/);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");

  await navigation.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page).toHaveURL(/#account$/);
  await expect(page.getByRole("heading", { name: "Account standing", level: 1 })).toBeVisible();
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
    await primary.getByRole("button", { name: "All conversations", exact: true }).click();
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
    await primary.getByRole("button", { name: "Profiles", exact: true }).click();
  }
  await page.getByRole("navigation", { name: "Agent configuration" }).getByRole("button", { name: "Skills", exact: true }).click();
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
    await primary.getByRole("button", { name: "Editor", exact: true }).click();
  }
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
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
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();

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

  // The local demo model cannot issue the strict structured safety verdict,
  // so Auto Approve must fail closed to a visible one-time human decision.
  await page.getByRole("combobox", { name: "Message Airship" }).fill("/write approvals/auto.txt reviewed");
  await page.getByRole("button", { name: "Send message" }).click();
  const autoFallback = page.getByRole("dialog", { name: /Allow write_file once/ });
  await expect(autoFallback).toBeVisible();
  await autoFallback.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();

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

test("desktop profile menu changes the real active profile and creates a coherent pinned session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile contract");
  await openReadyApp(page);
  const profile = page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" });
  await expect(profile).toContainText("General");
  await profile.click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  await listbox.getByRole("option", { name: /Research/ }).click();
  await expect(page.locator(".stage-header .eyebrow")).toContainText("Research");
  await expect(page.locator(".stage-header h1")).toContainText("Research");
  await expect(profile).toContainText("Research");
  await expect(listbox).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("profile-switched.png"), fullPage: true });
});

test("route gutter and density preferences apply consistently to the whole layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop layout contract");
  await openReadyApp(page);
  const comfortableHeader = await page.locator(".stage-header").boundingBox();
  const comfortableFont = await page.locator("html").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(comfortableHeader).not.toBeNull();
  expect(comfortableFont).toBeGreaterThanOrEqual(17);

  const offsets: number[] = [];
  for (const route of ["All conversations", "Workspace", "Profiles"] as const) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: route, exact: true }).click();
    const main = await page.locator("main.main").boundingBox();
    const content = await page.getByRole("heading", { level: 1 }).boundingBox();
    expect(main).not.toBeNull();
    expect(content).not.toBeNull();
    offsets.push(content!.x - main!.x);
  }
  expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1);
  expect(offsets[0]).toBeGreaterThanOrEqual(14);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat" }).click();
  await page.getByRole("button", { name: "Open Preferences" }).click();
  const density = page.getByRole("dialog", { name: "Preferences" }).getByLabel("Density");
  await density.click();
  await page.getByRole("listbox", { name: "Density" }).getByRole("option", { name: "Compact" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  const compactFont = await page.locator("html").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await page.getByRole("dialog", { name: "Preferences" }).getByRole("button", { name: "Done" }).click();
  const compactHeader = await page.locator(".stage-header").boundingBox();
  expect(compactHeader).not.toBeNull();
  expect(compactFont).toBeLessThan(comfortableFont);
  expect(compactHeader!.height).toBeLessThan(comfortableHeader!.height);
  await page.screenshot({ path: testInfo.outputPath("compact-layout.png"), fullPage: true });
});

test("mobile session header groups wrap without overlap and profile switching remains usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile profile and geometry contract");
  await openReadyApp(page);
  const sessionDetails = page.locator(".mobile-session-details");
  await expect(sessionDetails).toBeVisible();
  const stage = await page.locator(".stage-header").boundingBox();
  const details = await sessionDetails.boundingBox();
  expect(stage).not.toBeNull();
  expect(details).not.toBeNull();
  await expect(page.locator(".session-meta")).toBeHidden();
  await expect(sessionDetails).toContainText("Session");
  expect(details!.x).toBeGreaterThanOrEqual(stage!.x);
  expect(details!.x + details!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  expect(details!.y).toBeGreaterThanOrEqual(stage!.y);
  expect(details!.y + details!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);

  const profile = page.locator(".compact-profile-menu").getByRole("button", { name: "Agent profile" });
  await profile.click();
  await page.getByRole("listbox", { name: "Agent profile" }).getByRole("option", { name: /Builder \/ Systems/ }).click();
  await expect(page.locator(".stage-header .eyebrow")).toContainText("Builder / Systems");
  await expect(profile.locator(".profile-monogram")).toHaveText("BS");
  await page.screenshot({ path: testInfo.outputPath("mobile-header-profile.png"), fullPage: true });
});
