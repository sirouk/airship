import { expect, test, type Page } from "@playwright/test";

async function openWorkspace(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  await page.goto("/#editor");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
}

async function openAdvanced(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.getByRole("tab", { name: /Source Control/u }).click();
  const trigger = page.getByRole("button", { name: "Advanced source controls" });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Advanced source controls" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function switchToAlternateProfile(page: Page, mobile: boolean): Promise<void> {
  const trigger = mobile
    ? page.locator(".compact-profile-menu").getByRole("button", { name: "Agent profile" })
    : page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Agent profile" });
  await trigger.click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  await listbox.locator("[role='option'][aria-selected='false']").first().click();
  /*
   * Wait for the switch to finish, not merely for the old view to unmount.
   *
   * A Profile switch rebuilds a whole authority — namespace, Git object
   * database, tool registry — and then restores that Profile's conversation.
   * The advanced dialog disappears at the start of that, so returning there
   * would let the next navigation race the switch's own landing and be
   * overwritten by it. This is the same settle signal `profile-silo.spec.ts`
   * uses.
   */
  await expect(page.locator(".profile-cockpit-transition")).toHaveCount(0);
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
}

test("advanced source controls expose the complete repository workflow in the workbench", async ({ page }, testInfo) => {
  await openWorkspace(page);
  await expect(page.getByRole("tab", { name: "Sources", exact: true })).toHaveCount(0);

  const dialog = await openAdvanced(page);
  await expect(dialog.getByRole("heading", { name: "Repositories & worktrees" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Refresh repositories" })).toBeVisible();
  const sourceFacts = dialog.locator("details.git-sources-facts-disclosure");
  await expect(sourceFacts.locator("summary")).toContainText("Source facts");
  await expect(sourceFacts.locator("summary")).toContainText("4 facts · full detail");
  await expect(sourceFacts.locator("summary .status-mark")).toHaveCount(4);
  await sourceFacts.locator("summary").click();
  const factRows = sourceFacts.locator(".git-sources-facts");
  await expect(factRows).toBeVisible();
  await expect(factRows.locator(":scope > div")).toHaveCount(4);
  await expect(factRows.locator(".status-mark")).toHaveCount(4);
  await expect(factRows).toContainText("Version-bound writes");
  await expect(dialog.getByRole("tab", { name: /Changes/u })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "History", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tree", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Flat", exact: true })).toBeVisible();

  const repositoryControls = dialog.locator("details.git-repository-controls");
  if (!(await repositoryControls.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await repositoryControls.locator("summary").click();
  }
  await expect(repositoryControls.getByRole("button", { name: "Repository" })).toBeVisible();
  await expect(repositoryControls.getByRole("button", { name: "Switch branch" })).toBeVisible();
  await expect(repositoryControls.getByLabel("New branch")).toBeVisible();
  await expect(repositoryControls.getByRole("button", { name: "Create branch" })).toBeVisible();
  await expect(repositoryControls.getByLabel("Worktree branch")).toBeVisible();
  await expect(repositoryControls.getByLabel("Workspace path")).toBeVisible();
  await expect(repositoryControls.getByRole("button", { name: "Create worktree" })).toBeVisible();
  await expect(repositoryControls.getByRole("button", { name: "Remove selected worktree" })).toBeVisible();

  await expect(dialog.getByLabel("Message")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Commit locally" })).toBeVisible();
  const remote = dialog.locator("details.git-remote-boundary");
  if (!(await remote.evaluate((element) => (element as HTMLDetailsElement).open))) await remote.locator("summary").click();
  await expect(remote.getByRole("button", { name: "Fetch direct" })).toBeVisible();
  await expect(remote.getByRole("button", { name: /Push main/u })).toBeVisible();

  if (testInfo.project.name === "mobile-chromium") {
    const closeBox = await dialog.getByRole("button", { name: "Close advanced source controls" }).boundingBox();
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
  }

  // Modal keyboard containment and focus restoration are part of the same
  // workflow: no advanced control may become pointer-only or strand focus
  // behind the sheet.
  const close = dialog.getByRole("button", { name: "Close advanced source controls" });
  await close.focus();
  await close.press("Shift+Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Advanced source controls" })).toBeFocused();
});

test("legacy #sources redirects to the unified Editor without resurrecting a Sources mode", async ({ page }) => {
  await page.goto("/#sources");
  await expect(page).toHaveURL(/#editor$/);
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Sources", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Source Control/u })).toBeVisible();
});

test("advanced source state is fenced by the active profile authority", async ({ page }, testInfo) => {
  await openWorkspace(page);
  const prior = await openAdvanced(page);
  await prior.getByRole("button", { name: "Flat", exact: true }).click();
  await prior.getByRole("tab", { name: "History", exact: true }).click();

  await switchToAlternateProfile(page, testInfo.project.name === "mobile-chromium");
  await expect(prior).toHaveCount(0);

  // The new profile opens a new source-control instance. Neither the prior
  // profile's selected history panel nor its flat-tree preference survives.
  await page.goto("/#editor");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  const current = await openAdvanced(page);
  await expect(current.getByRole("tab", { name: /Changes/u })).toHaveAttribute("aria-selected", "true");
  await expect(current.getByRole("button", { name: "Tree", exact: true })).toHaveAttribute("aria-pressed", "true");
});
