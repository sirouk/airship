import { expect, test } from "@playwright/test";

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
  await expect(page).toHaveURL(/#chat$/);
  await navigation.getByRole("button", { name: "Expand recent conversations" }).click();
  await navigation.getByRole("button", { name: "All conversations", exact: true }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "Session library", level: 1 })).toBeVisible();

  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator(".session-id").click();
  await expect(page).toHaveURL(/#sessions$/);
});

test("mobile keeps conversations out of the fixed bar and exposes the ledger through More", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile conversation information architecture");
  await page.goto("/#chat");
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(navigation.getByRole("button", { name: "Sessions", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button")).toHaveCount(4);
  await navigation.getByRole("button", { name: "More", exact: true }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await more.getByRole("button").filter({ hasText: "All conversations" }).click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "Session library", level: 1 })).toBeVisible();
});

test("Workspace owns Sources and Terminal without breaking their deep links", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop nested workspace information architecture");
  await page.goto("/#workspace");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Sources", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Terminal", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(page).toHaveURL(/#sources$/);
  await navigation.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page).toHaveURL(/#terminal$/);
});

test("Sources defaults to a collapsible tree and Profiles archives without stranding history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop management information architecture");
  await page.goto("/#sources");
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
  const remove = page.getByRole("button", { name: /Remove profile|Only profile/u });
  await expect(remove).toBeDisabled();
  await page.locator(".profile-card").filter({ hasText: "Research Analyst" }).click();
  await expect(remove).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.getByText(/Removed from new work/u)).toBeVisible();
  await expect(page.locator(".profile-card").filter({ hasText: "Research Analyst" })).toHaveCount(0);
});

test("Memory unifies federated search, graph, and the legacy Context index deep link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop memory information architecture");
  await page.goto("/#memory");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Context", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Current conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("Active profile memory", { exact: true })).toBeVisible();
  await expect(page.getByText("Shared workspace & sources", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page.getByLabel("Interactive memory relationship graph")).toBeVisible();
  await page.goto("/#context");
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Index" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Context index status")).toBeVisible();
});

test("Profiles uses a bounded disclosure and one scoped tabbed manager", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile information architecture");
  await page.goto("/#chat");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Capabilities", exact: true })).toHaveCount(0);
  await navigation.getByRole("button", { name: "Expand profiles" }).click();
  const profileList = navigation.locator("#airship-profile-navigation");
  expect(await profileList.locator(".recent-conversation").count()).toBeLessThanOrEqual(8);
  await profileList.getByRole("button", { name: /Research Analyst/u }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await expect(page.getByRole("button", { name: "Profile manager scope" })).toContainText("Research Analyst");
  await expect(page.locator(".profile-card.active")).toContainText("Research Analyst");
  await page.getByRole("tab", { name: "Capabilities" }).click();
  await expect(page.getByRole("heading", { name: "Capabilities", level: 1 })).toBeVisible();
  await expect(page.getByText(/Availability is measured and read-only/u)).toBeVisible();
  await page.getByRole("tab", { name: "Skills" }).click();
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByText("Profile scope", { exact: true })).toBeVisible();
});
