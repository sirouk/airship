import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function openIsolatedWorkspace(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  await page.goto("/#workspace");
  // AMENDED: this asserted `heading "Editor"` on `#workspace`. That assertion
  // pinned the defect — one component served two destinations and hard-coded
  // one wrong name, so the rail said Workspace, the H1 said Editor and the
  // eyebrow said PAGE WORKSPACE. The replacement is stronger because it binds
  // the heading to the route rather than to a constant: it fails if either
  // destination renders the other's name.
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
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
  // AMENDED: `.editor-status` merged with `.editor-toolbar` into one
  // `.editor-strip`. The replacement keeps the word and adds the invariant the
  // old assertion could not see: the strip measured at y=959 on a 900px
  // viewport, so "Saved" was true and invisible on every device. It now has to
  // be inside the viewport.
  await expect(page.locator(".editor-strip")).toContainText("Saved");
  await expect(page.locator(".editor-strip")).toBeInViewport();
  // AMENDED: the dirty marker moved from a bespoke `<b>` onto the shared
  // <Tabs> state seal. Asserting the accessible name is stronger than counting
  // an element: it proves a screen reader is told the buffer is clean, which
  // the CSS-structural count never did.
  await expect(page.getByRole("tab", { name: /architecture\.md/ })).not.toHaveAccessibleName(/Unsaved/u);

  await editor.fill("The saved revision.\nThis draft must not disappear.\n");
  await page.getByRole("button", { name: "Close architecture.md" }).click();
  const discard = page.getByRole("dialog", { name: "discard workspace file" });
  await expect(discard).toContainText("permanently discard");
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveValue(/must not disappear/u);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".editor-strip")).toContainText("Saved");

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

test("each workbench destination names itself and its modal closes on Escape", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop workbench contract");
  await openIsolatedWorkspace(page);

  // Two hash destinations render one component. Each now states its own name
  // instead of sharing one wrong one.
  await page.goto("/#editor");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();

  // `.workbench-dialog` was the only modal in Airship with neither
  // Escape-to-close nor a focus trap; a live run could not dismiss this dialog
  // and had to be killed.
  const target = page.getByRole("treeitem", { name: /retrieval\.md/ });
  await target.focus();
  await target.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move…" }).click();
  const move = page.getByRole("dialog", { name: "move workspace file" });
  await expect(move).toBeVisible();
  // The dialog never named the file it was about, or where that file was.
  await expect(move).toContainText("Move retrieval.md");
  await expect(move).toContainText("Currently in workspace/notes");
  await move.press("Escape");
  await expect(move).toHaveCount(0);
});

test("mobile workbench uses pane switching and an explicit folder move sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile workbench contract");
  await openIsolatedWorkspace(page);

  await page.getByRole("treeitem", { name: /retrieval\.md/ }).click();
  const editor = page.getByRole("textbox", { name: "Edit retrieval.md" });
  await expect(editor).toBeVisible();
  // `.editor-toolbar small { display: none }` deleted the revision hash and the
  // byte size below 760px with no way to recover either. Both are on a phone.
  const strip = page.locator(".editor-strip");
  await expect(strip).toBeInViewport();
  await expect(strip).toContainText(/rev [0-9a-f]{7}/u);
  await expect(strip).toContainText(/\d+ B/u);
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
