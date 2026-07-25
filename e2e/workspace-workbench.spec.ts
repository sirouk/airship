import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function openIsolatedWorkspace(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  await page.goto("/#workspace");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Workspace files" })).toBeVisible();
}

test("desktop workbench edits with CAS, keeps tabs, and surfaces the real Git change", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop workbench contract");
  await openIsolatedWorkspace(page);

  const docs = page.getByRole("treeitem", { name: /docs$/u });
  await docs.focus();
  await docs.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Collapse" }).click();
  await expect(page.getByRole("tab", { name: "docs", exact: true })).toHaveCount(0);
  await docs.focus();
  await docs.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: /architecture\.md/ })).toBeVisible();

  await page.getByRole("treeitem", { name: /README\.md/ }).click();
  await page.getByRole("treeitem", { name: /architecture\.md/ }).click();
  await expect(page.getByRole("tab", { name: /README\.md/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /architecture\.md/ })).toHaveAttribute("aria-selected", "true");

  const editor = page.getByRole("textbox", { name: "Edit architecture.md" });
  await editor.fill("The browser owns orchestration.\nWorkbench edit is version fenced.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".workbench-notice")).toContainText("Saved architecture.md");
  await expect(page.locator(".editor-status")).toContainText("Saved");
  await expect(page.locator(".editor-tabs > div.active b")).toHaveCount(0);

  await editor.fill("The saved revision.\nThis draft must not disappear.\n");
  await page.getByRole("button", { name: "Close architecture.md" }).click();
  const discard = page.getByRole("dialog", { name: "discard workspace file" });
  await expect(discard).toContainText("permanently discard");
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveValue(/must not disappear/u);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".editor-status")).toContainText("Saved");

  await page.getByRole("tab", { name: /Source Control/ }).click();
  await expect(page.getByRole("button", { name: /docs\/architecture\.md [AM]/u })).toBeVisible();
  await page.getByRole("button", { name: "Stage docs/architecture.md" }).click();
  const stageApproval = page.getByRole("dialog", { name: /Allow git_stage once/ });
  if (await stageApproval.isVisible()) await stageApproval.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByRole("button", { name: "Unstage docs/architecture.md" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workspace-workbench-desktop.png"), fullPage: true });

  await page.reload();
  await expect(page.getByRole("tab", { name: /architecture\.md/ })).toHaveAttribute("aria-selected", "true");
  const restored = page.getByRole("textbox", { name: "Edit architecture.md" });
  await expect(restored).toBeVisible();
  await restored.fill("Save-and-close is explicit.\n");
  await page.getByRole("button", { name: "Close architecture.md" }).click();
  const closeDialog = page.getByRole("dialog", { name: "discard workspace file" });
  await closeDialog.getByRole("button", { name: "Save and close" }).click();
  await expect(page.getByRole("tab", { name: /architecture\.md/ })).toHaveCount(0);
});

test("mobile workbench uses pane switching and an explicit folder move sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile workbench contract");
  await openIsolatedWorkspace(page);

  await page.getByRole("treeitem", { name: /retrieval\.md/ }).click();
  const editor = page.getByRole("textbox", { name: "Edit retrieval.md" });
  await expect(editor).toBeVisible();
  await editor.fill("Unsaved mobile draft follows its tab.\n");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Actions for retrieval.md" }).click();
  await page.getByRole("menuitem", { name: "Move…" }).click();
  const move = page.getByRole("dialog", { name: "move workspace file" });
  await expect(move).toBeVisible();
  await move.getByRole("option", { name: "workspace/docs" }).click();
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(page.locator(".workbench-notice")).toContainText("Unsaved edits moved with the tab");
  await expect(page.getByRole("textbox", { name: "Edit retrieval.md" })).toHaveValue(/follows its tab/u);
  await page.screenshot({ path: testInfo.outputPath("workspace-workbench-mobile.png"), fullPage: true });
});
