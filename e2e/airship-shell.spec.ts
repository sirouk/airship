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
  await expect(page.getByRole("heading", { name: "Session library", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace" }).click();
  await expect(page).toHaveURL(/#workspace$/);
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.getByRole("region", { name: "Agent session" })).toBeVisible();
  await capture(page, testInfo, "desktop-shell.png");
});

test("desktop navigation exposes profile tabs and Account with one active page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop nested navigation contract");
  await openReadyApp(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });

  await navigation.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/#skills$/);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Skills", exact: true })).toHaveAttribute("aria-selected", "true");

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

  await primary.getByRole("button", { name: "All conversations", exact: true }).click();
  const provider = page.getByRole("button", { name: "Filter by provider" });
  await provider.click();
  const providerList = page.getByRole("listbox", { name: "Filter by provider" });
  await expect(providerList).toBeVisible();
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
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  const profile = page.getByRole("button", { name: "Preview profile resolution" });
  await profile.click();
  const profileList = page.getByRole("listbox", { name: "Preview profile resolution" });
  const alternateProfile = profileList.locator("[role='option'][aria-selected='false']");
  await alternateProfile.first().click();
  await expect(profile).not.toContainText("Systems Engineer");

  if (mobile) {
    await primary.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "Sources" }).first().click();
  } else {
    await primary.getByRole("button", { name: "Sources", exact: true }).click();
  }
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
  await expect(page.getByRole("heading", { name: "Session library", level: 1 })).toBeVisible();

  await mobileNavigation.getByRole("button", { name: "Workspace" }).click();
  await expect(page).toHaveURL(/#workspace$/);
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

test("approval mode control clearly switches the live browser-agent policy", async ({ page }, testInfo) => {
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
  const approvalMode = preferences.getByLabel("Agent approvals");
  await expect(approvalMode).toContainText("Ask First");
  await approvalMode.click();
  await page.getByRole("listbox", { name: "Agent approvals" }).getByRole("option", { name: /Auto Approve/ }).click();
  await expect(preferences.getByText("Auto Approve.", { exact: true })).toBeVisible();
  await preferences.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".composer-tools")).toContainText("Auto Approve");

  // The local demo model cannot issue the strict structured safety verdict,
  // so Auto Approve must fail closed to a visible one-time human decision.
  await page.getByRole("combobox", { name: "Message Airship" }).fill("/write approvals/auto.txt reviewed");
  await page.getByRole("button", { name: "Send message" }).click();
  const autoFallback = page.getByRole("dialog", { name: /Allow write_file once/ });
  await expect(autoFallback).toBeVisible();
  await autoFallback.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();

  await page.getByRole("button", { name: "Open Preferences" }).click();
  const fullAccessMenu = page.getByRole("dialog", { name: "Preferences" }).getByLabel("Agent approvals");
  await fullAccessMenu.click();
  await page.getByRole("listbox", { name: "Agent approvals" }).getByRole("option", { name: /Full Access/ }).click();
  await expect(preferences.getByText("Full Access.", { exact: true })).toBeVisible();
  await expect(preferences).toContainText("same explicit browser tools, schemas, path confinement, and network boundaries");
  await preferences.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".composer-tools")).toContainText("Full Access");

  await page.getByRole("combobox", { name: "Message Airship" }).fill("/write approvals/full.txt bounded");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Local result · excluded from model context").last()).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Allow write_file once/ })).toHaveCount(0);

  // Persistence is part of the policy contract, not just menu presentation.
  await page.reload();
  await expect(page.locator(".composer-tools")).toContainText("Full Access");

  await page.getByRole("button", { name: "Open Preferences" }).click();
  const reopenedApprovalMode = page.getByRole("dialog", { name: "Preferences" }).getByLabel("Agent approvals");
  await expect(reopenedApprovalMode).toContainText("Full Access");
  await reopenedApprovalMode.click();
  await page.getByRole("listbox", { name: "Agent approvals" }).getByRole("option", { name: /Ask First/ }).click();
  await expect(page.getByRole("dialog", { name: "Preferences" }).getByText("Ask First.", { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Preferences" }).getByRole("button", { name: "Done" }).click();
  await page.reload();
  await expect(page.locator(".composer-tools")).toContainText("Ask First");
  await page.screenshot({ path: testInfo.outputPath("approval-mode-menu.png"), fullPage: true });
});

test("desktop profile menu changes the real active profile and creates a coherent pinned session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile contract");
  await openReadyApp(page);
  const profile = page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" });
  await expect(profile).toContainText("Systems Engineer");
  await profile.click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  await listbox.getByRole("option", { name: /Research Analyst/ }).click();
  await expect(page.locator(".stage-header .eyebrow")).toContainText("Research Analyst");
  await expect(page.locator(".stage-header h1")).toContainText("Research Analyst");
  await expect(profile).toContainText("Research Analyst");
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
  const stage = await page.locator(".stage-header").boundingBox();
  const trust = await page.locator(".session-meta-trust").boundingBox();
  const record = await page.locator(".session-meta-record").boundingBox();
  expect(stage).not.toBeNull();
  expect(trust).not.toBeNull();
  expect(record).not.toBeNull();
  expect(record!.y).toBeGreaterThanOrEqual(trust!.y + trust!.height - 1);
  for (const box of [trust!, record!]) {
    expect(box.x).toBeGreaterThanOrEqual(stage!.x);
    expect(box.x + box.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  }

  const profile = page.locator(".compact-profile-menu").getByRole("button", { name: "Agent profile" });
  await profile.click();
  await page.getByRole("listbox", { name: "Agent profile" }).getByRole("option", { name: /Security Reviewer/ }).click();
  await expect(page.locator(".stage-header .eyebrow")).toContainText("Security Reviewer");
  await expect(profile.locator(".profile-monogram")).toHaveText("SR");
  await page.screenshot({ path: testInfo.outputPath("mobile-header-profile.png"), fullPage: true });
});
