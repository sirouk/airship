import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function seedDisplayPreferences(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
}

async function openIsolatedWorkspace(page: Page): Promise<void> {
  await seedDisplayPreferences(page);
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

  await page.getByRole("treeitem", { name: /README\.md/ }).dblclick();
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
  // AMENDED: this selected the dialog by `aria-label="discard workspace file"`,
  // an interpolation of the internal enum. The dialog's accessible name is now
  // its own visible heading, so there is one name instead of two that can
  // drift. Naming it by the heading is the stronger assertion: it fails if the
  // heading and the accessible name ever separate again.
  const discard = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(discard).toContainText("permanently discard");
  await expect(page.getByRole("dialog", { name: /workspace file$/u })).toHaveCount(0);
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveValue(/must not disappear/u);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".editor-strip")).toContainText("Saved");

  await page.getByRole("tab", { name: /Source Control/ }).click();
  // The row announces the delta as a word, not as the bare letter it draws:
  // a status column that reads out "M" was the defect `aria-name-contract`
  // was written for, and the letter is now `aria-hidden` decoration under a
  // name that says the whole thing.
  await expect(page.getByRole("button", { name: /docs\/architecture\.md · Working (added|modified)/u })).toBeVisible();
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
  const closeDialog = page.getByRole("dialog", { name: "Unsaved changes" });
  await closeDialog.getByRole("button", { name: "Save and close" }).click();
  await expect(page.getByRole("tab", { name: /architecture\.md/ })).toHaveCount(0);
});

test("document tabs preview once, pin on intent, survive activity switches, and close by every supported path", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop document-tab lifecycle");
  await openIsolatedWorkspace(page);

  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  const readmePreview = page.getByRole("tab", { name: /README\.md, Preview/u });
  await expect(readmePreview).toBeVisible();
  expect(await readmePreview.locator(".tabs__label").evaluate((node) => getComputedStyle(node).fontStyle)).toBe("italic");

  // A second single-click replaces the one clean preview rather than growing
  // the strip with every file the user inspects.
  await page.getByRole("treeitem", { name: /architecture\.md/u }).click();
  await expect(page.getByRole("tab", { name: /README\.md/u })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /architecture\.md, Preview/u })).toBeVisible();

  // Double-click is explicit keep-open intent. The first click replaces the
  // preview; the double-click promotion then removes Preview from the name.
  await page.getByRole("treeitem", { name: /retrieval\.md/u }).dblclick();
  await expect(page.getByRole("tab", { name: /retrieval\.md, Preview/u })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /retrieval\.md/u })).toBeVisible();

  // First edit is the other pin gesture. A later preview cannot displace this
  // dirty document, and the action is available without a double-click.
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  const readme = page.getByRole("textbox", { name: "Edit README.md" });
  await readme.fill("Dirty previews pin before another file can replace them.\n");
  await expect(page.getByRole("tab", { name: /README\.md, Preview/u })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /README\.md, Unsaved/u })).toBeVisible();
  await page.getByRole("treeitem", { name: /architecture\.md/u }).click();
  await expect(page.getByRole("tab", { name: /README\.md, Unsaved/u })).toBeVisible();
  const architecture = page.getByRole("tab", { name: /architecture\.md, Preview/u });
  await expect(architecture).toBeVisible();

  // Workspace activity switching does not remount or reset the document model.
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(architecture).toBeVisible();
  await expect(page.getByRole("tab", { name: /README\.md, Unsaved/u })).toBeVisible();

  // Middle-click uses the same close contract as the explicit close button.
  await architecture.click({ button: "middle" });
  await expect(architecture).toHaveCount(0);
  await page.getByRole("button", { name: "Close retrieval.md" }).click();
  await expect(page.getByRole("tab", { name: /retrieval\.md/u })).toHaveCount(0);
});

test("source status and history open real patch documents with the shared preview lifecycle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop diff-document lifecycle");
  await openIsolatedWorkspace(page);
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await page.getByRole("textbox", { name: "Edit README.md" }).fill("Unsaved editor text is not yet a Git patch.\n");
  await page.getByRole("tab", { name: /Source Control/u }).click();

  // A status row opens the adapter's bounded diff, not the working file. The
  // worktree version is part of the identity and verified around the read.
  await page.getByRole("button", { name: /README\.md · Working modified/u }).click();
  const statusPreview = page.getByRole("tab", { name: /README\.md · worktree diff, Working diff, Preview/u });
  await expect(statusPreview).toBeVisible();
  await expect(page.getByRole("tab", { name: /README\.md, Unsaved/u })).toBeVisible();
  const statusPatch = page.getByRole("region", { name: "Working diff README.md" });
  await expect(statusPatch).toContainText("Initial browser repository snapshot");
  await expect(statusPatch).toContainText("Private workspace");
  await expect(statusPatch).not.toContainText("Unsaved editor text");

  // History comes from git.log/git.show and participates in the exact same
  // preview slot. The previous clean status preview is displaced.
  await page.getByRole("button", { name: /Initial browser workspace/u }).click();
  await expect(statusPreview).toHaveCount(0);
  const historyPreview = page.getByRole("tab", { name: /Commit [0-9a-f]+, Commit diff, Preview/u });
  await expect(historyPreview).toBeVisible();
  await expect(page.getByRole("region", { name: /Commit [0-9a-f]+ diff/u })).toContainText("Initial browser workspace");

  // The explicit keep action is touch-accessible and pins the commit before a
  // later status preview takes the replaceable slot.
  await page.getByRole("button", { name: /Open and keep commit [0-9a-f]+ diff/u }).click();
  await expect(page.getByRole("tab", { name: /Commit [0-9a-f]+, Commit diff, Preview/u })).toHaveCount(0);
  const keptHistory = page.getByRole("tab", { name: /Commit [0-9a-f]+, Commit diff/u });
  await page.getByRole("button", { name: /docs\/architecture\.md · Working added/u }).click();
  await expect(keptHistory).toBeVisible();
  await expect(page.getByRole("tab", { name: /docs\/architecture\.md · worktree diff, Working diff, Preview/u })).toBeVisible();
});

test("file-type icons and Reveal in Explorer preserve exact document context", async ({ page }, testInfo) => {
  await openIsolatedWorkspace(page);

  const readme = page.getByRole("treeitem", { name: /README\.md/u });
  await expect(readme.locator('[data-file-kind="markdown"]')).toBeVisible();
  await readme.click();
  const readmeTab = page.getByRole("tab", { name: /README\.md, Preview/u });
  await expect(readmeTab.locator('[data-file-kind="markdown"]')).toBeVisible();

  // The same explicit action works with a pointer, keyboard, or finger. It
  // navigates to the path instead of reopening it, and focus lands on the
  // selected tree row so keyboard traversal can continue from there.
  await page.getByRole("button", { name: "Reveal in Explorer", exact: true }).click();
  await expect(readme).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(":focus")).toHaveAttribute("title", /\/workspace\/README\.md/u);
  await expect(page.locator('.editor-tabs .tabs__tab[data-active="true"]')).toContainText("README.md");

  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: /Initial browser workspace/u }).click();
  const historyTab = page.getByRole("tab", { name: /Commit [0-9a-f]+, Commit diff, Preview/u });
  await expect(historyTab.locator("svg")).toBeVisible();
  // This root commit has one exact changed path, so the control is direct. A
  // multi-path commit promotes the same action to the keyboard/touch menu.
  const historyReveal = page.getByRole("button", { name: "Reveal in Explorer", exact: true });
  await expect(historyReveal).toBeVisible();
  await historyReveal.click();
  await expect(readme).toHaveAttribute("aria-selected", "true");
  // A reveal from a whole-commit document keeps that immutable commit tab
  // active; on a phone, the Files pane is simply presented in front of it.
  await expect(page.locator('.editor-tabs .tabs__tab[data-active="true"]')).toContainText(/^[0-9a-f]{12}/u);
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("tab", { name: /^Editor/u }).click();
  }
  await expect(page.getByRole("region", { name: /Commit [0-9a-f]+ diff/u })).toBeVisible();

  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: /README\.md · Working modified/u }).click();
  const statusTab = page.getByRole("tab", { name: /README\.md · worktree diff, Working diff, Preview/u });
  await expect(statusTab.locator('[data-file-kind="markdown"]')).toBeVisible();
  await page.getByRole("button", { name: "Reveal in Explorer", exact: true }).click();
  await expect(readme).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.editor-tabs .tabs__tab[data-active="true"]')).toContainText("README.md");
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
  // AMENDED with the discard dialog above: the accessible name is the heading.
  const move = page.getByRole("dialog", { name: "Move retrieval.md" });
  await expect(move).toBeVisible();
  // The dialog never named the file it was about, or where that file was.
  await expect(move).toContainText("Move retrieval.md");
  await expect(move).toContainText("Currently in workspace/notes");
  await move.press("Escape");
  await expect(move).toHaveCount(0);
  // A context-menu item unmounts with its menu, so restoring focus to "whatever
  // opened this" dropped the keyboard on `<body>`. It lands back on the row.
  await expect(page.locator(":focus")).toHaveClass(/tree-row/u);
});

test("mobile workbench uses pane switching and an explicit folder move sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile workbench contract");
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openIsolatedWorkspace(page);

  await page.getByRole("tab", { name: /Source Control/u }).click();
  const keepStatusDiff = page.getByRole("button", { name: "Open and keep unstaged diff README.md" });
  await expect(keepStatusDiff).toBeVisible();
  await expect(page.getByRole("button", { name: /Open and keep commit [0-9a-f]+ diff/u })).toBeVisible();
  const target = await keepStatusDiff.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(44);
  expect(target?.height).toBeGreaterThanOrEqual(44);
  await keepStatusDiff.click();
  await expect(page.getByRole("region", { name: "Working diff README.md" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /README\.md · worktree diff, Working diff, Preview/u })).toHaveCount(0);
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();

  await page.getByRole("treeitem", { name: /retrieval\.md/ }).click();
  const editor = page.getByRole("textbox", { name: "Edit retrieval.md" });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("tab", { name: /retrieval\.md, Preview/u })).toBeVisible();
  // `.editor-toolbar small { display: none }` deleted the revision hash and the
  // byte size below 760px with no way to recover either. Both are on a phone.
  const strip = page.locator(".editor-strip");
  await expect(strip).toBeInViewport();
  await expect(strip).toContainText(/rev [0-9a-f]{7}/u);
  await expect(strip).toContainText(/\d+ B/u);
  await editor.fill("Unsaved mobile draft follows its tab.\n");
  await expect(page.getByRole("tab", { name: /retrieval\.md, Preview/u })).toHaveCount(0);
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByRole("button", { name: "Actions for retrieval.md" }).click();
  await expect(page.getByRole("menuitem", { name: "Open and keep" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Move…" }).click();
  const move = page.getByRole("dialog", { name: "Move retrieval.md" });
  await expect(move).toBeVisible();
  await move.getByRole("option", { name: "workspace/docs" }).click();
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(page.locator(".workbench-notice")).toContainText("Unsaved edits moved with the tab");
  await expect(page.getByRole("textbox", { name: "Edit retrieval.md" })).toHaveValue(/follows its tab/u);
  await page.screenshot({ path: testInfo.outputPath("workspace-workbench-mobile.png"), fullPage: true });
  expect(pageErrors, "mobile pane and tree measurements must settle without a resize-delivery error").toEqual([]);
});

test("folders can be created, renamed and deleted, and every step states its real cost", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop workbench contract");
  await openIsolatedWorkspace(page);

  // The shipped folder menu was Expand / New file… and nothing else, so a
  // folder could be created only by typing a slash into a filename and could
  // never be renamed or deleted at all.
  const notes = page.getByRole("treeitem", { name: /notes$/u });
  await notes.focus();
  await notes.press("Shift+F10");
  await page.getByRole("menuitem", { name: "New folder…" }).click();

  const create = page.getByRole("dialog", { name: "New folder" });
  await expect(create).toBeVisible();
  // Directories are derived from file paths and `WorkspacePort` has no mkdir,
  // so the dialog states the file it is really about to write.
  await expect(create).toContainText(".gitkeep");
  const createButton = create.getByRole("button", { name: "Create folder" });
  await expect(createButton).toBeDisabled();
  // A rejected name says why, rather than only disabling the button.
  await create.getByRole("textbox").fill("a/b");
  await expect(create).toContainText("one segment");
  await expect(createButton).toBeDisabled();
  await create.getByRole("textbox").fill("2026");
  await createButton.click();
  await expect(page.locator(".workbench-notice")).toContainText("Created notes/2026/");
  await expect(page.getByRole("treeitem", { name: /2026/u })).toBeVisible();

  // Rename: N moves, and the confirmation counts them before it runs.
  await notes.focus();
  await notes.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Rename folder…" }).click();
  const rename = page.getByRole("dialog", { name: "Rename notes" });
  await expect(rename).toContainText("Moves the 2 files under notes");
  await expect(rename).toContainText("one compare-and-swapped file operation per file");
  await rename.getByRole("textbox").fill("journal");
  await rename.getByRole("button", { name: "Rename 2 files" }).click();
  await expect(page.locator(".workbench-notice")).toContainText("Renamed 2 files in journal.");
  await expect(page.getByRole("treeitem", { name: /notes$/u })).toHaveCount(0);

  // Delete: the folder row hides how much one "Delete" removes, so the dialog
  // names every doomed path and the button carries the count.
  const journal = page.getByRole("treeitem", { name: /journal$/u });
  await journal.focus();
  await journal.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Delete folder…" }).click();
  const remove = page.getByRole("dialog", { name: "Delete journal" });
  await expect(remove).toContainText("journal/retrieval.md");
  await expect(remove).toContainText("journal/2026/.gitkeep");
  await remove.getByRole("button", { name: "Delete 2 files" }).click();
  await expect(page.locator(".workbench-notice")).toContainText("Deleted 2 files in journal.");
  await expect(page.getByRole("treeitem", { name: /journal$/u })).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: /README\.md/u })).toBeVisible();
});

test("the editor states whether it is wrapping, and stops overflowing when it is", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop workbench contract");
  await openIsolatedWorkspace(page);
  await page.getByRole("treeitem", { name: /README\.md/u }).click();

  // `.code-editor` was `white-space: pre` at every width with no control, so a
  // prose file ran off the pane and the gutter was `display: none` below 760px
  // with nothing said. Wrap is now a stated, persisted mode.
  const wrap = page.getByRole("button", { name: "Wrap" });
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  const overflow = () => page.evaluate(() => {
    const node = document.querySelector(".code-editor");
    return node ? node.scrollWidth - node.clientWidth : -1;
  });
  expect(await overflow()).toBeGreaterThan(0);
  await expect(page.locator(".code-gutter")).toBeVisible();

  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  expect(await overflow()).toBe(0);
  // Numbers beside a soft-wrapped buffer would count visual rows, so the gutter
  // is retired — and the strip says so instead of letting it vanish silently.
  await expect(page.locator(".code-gutter")).toHaveCount(0);
  await expect(page.locator(".editor-strip")).toContainText("wrapped, no line numbers");

  await page.reload();
  await expect(page.getByRole("button", { name: "Wrap" })).toHaveAttribute("aria-pressed", "true");
});

test("the file you just closed reopens, and same-named documents keep distinct close buttons", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop document lifecycle");
  await openIsolatedWorkspace(page);

  // The shipped defect: App re-published the same (path, revision) selection
  // and the buffer-load effect was keyed on that *value*, so the open after a
  // close was indistinguishable from a no-op and the pane stayed empty.
  await page.getByRole("treeitem", { name: /README\.md/u }).dblclick();
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toBeVisible();
  await page.getByRole("button", { name: "Close README.md" }).click();
  await expect(page.getByRole("tab", { name: /README\.md/u })).toHaveCount(0);
  await expect(page.locator(".workbench-empty")).toBeVisible();

  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await expect(page.getByRole("tab", { name: /README\.md/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toBeVisible();
  await expect(page.locator(".workbench-empty")).toHaveCount(0);

  // The other half of keying on identity: a re-published selection for a file
  // with a dirty draft must not overwrite that draft.
  await page.getByRole("textbox", { name: "Edit README.md" }).fill("A draft that must survive a republished selection.\n");
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toHaveValue(/must survive/u);

  // Two documents whose basenames collide: the tab names were disambiguated
  // and the close buttons beside them were not, so a screen reader offered two
  // identical "Close index.ts" controls for two different files.
  for (const path of ["docs/index.ts", "notes/index.ts"]) {
    await page.getByRole("button", { name: "New file", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New file" });
    await create.getByRole("textbox").fill(path);
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator(".workbench-notice")).toContainText(`Created ${path}`);
  }
  // Both are previews until they are kept, and one preview slot holds one
  // document. The row title carries the full path, which is the only thing
  // that tells these two rows apart.
  await page.locator('.tree-row[title^="/workspace/docs/index.ts"]').dblclick();
  await page.locator('.tree-row[title^="/workspace/notes/index.ts"]').dblclick();
  await expect(page.getByRole("button", { name: "Close docs/index.ts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close notes/index.ts" })).toBeVisible();
  // README.md is unique, so its label is untouched by the qualifier.
  await expect(page.getByRole("button", { name: "Close README.md" })).toBeVisible();
});

test("the Explorer row menu is a menu: it takes focus, moves by arrow, and gives focus back", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop keyboard contract");
  await openIsolatedWorkspace(page);

  const target = page.getByRole("treeitem", { name: /retrieval\.md/u });
  await target.focus();
  await target.press("Shift+F10");
  const items = page.locator('.workbench-context [role="menuitem"]');
  // Shift+F10 used to open a `role="menu"` the keyboard could not enter: the
  // menu was a positioned popup with menu roles and none of the pattern.
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await expect(page.getByRole("menu", { name: "Actions for retrieval.md" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workbench-context")).toHaveCount(0);
  await expect(target).toBeFocused();

  // An Apple keyboard has no ContextMenu key and answers F10 with a system
  // media action, so Ctrl+Enter is the door that exists on every platform.
  // The whole rename below is keyboard-only — there is no click in it.
  await target.press("Control+Enter");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items.filter({ hasText: "Rename…" })).toBeFocused();
  await page.keyboard.press("Enter");
  const rename = page.getByRole("dialog", { name: "Rename retrieval.md" });
  await expect(rename).toBeVisible();
  await rename.getByRole("textbox").fill("retrieval-notes.md");
  await rename.getByRole("textbox").press("Enter");
  await expect(page.getByRole("treeitem", { name: /retrieval-notes\.md/u })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /retrieval\.md/u })).toHaveCount(0);
});

test("the virtualised tree states its real size and owns nothing but treeitems", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop tree structure");
  await openIsolatedWorkspace(page);

  const structure = await page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]')!;
    const rows = [...tree.querySelectorAll('[role="treeitem"]')];
    return {
      count: rows.length,
      sizes: [...new Set(rows.map((row) => row.getAttribute("aria-setsize")))],
      positions: rows.map((row) => Number(row.getAttribute("aria-posinset"))),
      // Every wrapper between the tree and its rows must be presentational, or
      // the tree owns a generic box instead of a treeitem.
      generics: rows.filter((row) => {
        for (let node = row.parentElement; node && node !== tree; node = node.parentElement) {
          if (node.getAttribute("role") !== "presentation") return true;
        }
        return false;
      }).length,
      // The `•••` button is adopted by its row, so it is not a `role=button`
      // owned directly by `role=tree`.
      unadopted: rows.filter((row) => {
        const owned = row.getAttribute("aria-owns");
        const target = owned ? document.getElementById(owned) : null;
        return !target?.classList.contains("tree-overflow");
      }).length,
      // Nothing inside the tree is tabbable except the one roving row.
      tabbable: [...tree.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]")]
        .filter((node) => node.tabIndex >= 0 && node.getAttribute("role") !== "treeitem").length,
    };
  });

  expect(structure.count).toBeGreaterThan(3);
  expect(structure.sizes).toEqual([String(structure.count)]);
  expect(structure.positions).toEqual(Array.from({ length: structure.count }, (_value, index) => index + 1));
  expect(structure.generics).toBe(0);
  expect(structure.unadopted).toBe(0);
  expect(structure.tabbable).toBe(0);

  // What the adoption costs if it is left bare. `treeitem` names itself from
  // content, and accname walks *owned* children too, so `aria-owns` alone made
  // every row announce "README.md 184 B Actions for README.md" — its own name
  // twice. These are the only assertions in the suite that read a computed
  // accessible name; the row locators elsewhere are unanchored regexes that
  // match the doubled name just as happily as the correct one.
  await expect(page.getByRole("treeitem", { name: /Actions for/u })).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "docs", exact: true })).toBeVisible();
  // `formatBytes` emits binary units — KiB/MiB/GiB — so the unit group has to
  // admit the `i`. Written without it this passed only while the seed README
  // stayed under 1,024 bytes, and failed the moment it said one more true thing.
  await expect(page.getByRole("treeitem", { name: /^README\.md \d+(?:\.\d)? [KMGT]?i?B$/u })).toBeVisible();
  // And the button keeps the name that makes it reachable — the point of
  // adopting it rather than hiding it.
  await expect(page.getByRole("button", { name: "Actions for README.md" })).toHaveCount(1);

  // The tree's own contract: Tab leaves it in one press.
  await page.getByRole("treeitem", { name: /README\.md/u }).focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.querySelector('[role="tree"]')!.contains(document.activeElement))).toBe(false);
});

test("Download is offered for a file and withheld from a folder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop export surface");
  await openIsolatedWorkspace(page);

  const file = page.getByRole("treeitem", { name: /README\.md/u });
  await file.focus();
  await file.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Download" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Folder-as-archive was explicitly not built, so no folder may offer a verb
  // that would have to invent one.
  const folder = page.getByRole("treeitem", { name: /docs$/u });
  await folder.focus();
  await folder.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "New folder…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Download" })).toHaveCount(0);
});

test("phone destinations keep switching panes after the first one", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile pane contract");
  await openIsolatedWorkspace(page);

  // `opensPane` was read once, as a `useState` initializer, for a component
  // that is never remounted between #workspace and #editor — so the route→pane
  // mapping applied exactly once in the component's lifetime.
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toBeVisible();

  await page.goto("/#workspace");
  await expect(page.locator(".workbench-activity")).toHaveClass(/mobile-active/u);
  await expect(page.getByRole("tree", { name: "Workspace files" })).toBeVisible();

  await page.goto("/#editor");
  await expect(page.locator(".workbench-editor")).toHaveClass(/mobile-active/u);
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toBeVisible();

  // The one exception: the mobile switch disables Editor at zero open tabs, so
  // arriving there with nothing open must not strand the user on a dead pane.
  //
  // AMENDED: this went to #workspace and then clicked Close README.md, which a
  // phone cannot do — the close button lives in the document strip inside the
  // editor pane, and a one-pane layout showing the tree hides it. The step was
  // only reachable while the pane was stuck, i.e. it depended on the very
  // defect this test exists to catch. The replacement keeps the visit to
  // #workspace, asserts the tree it lands on, and then reaches the strip the
  // way a phone user has to — the pane switch — so it proves one thing more
  // than the original: the in-page switch and the destinations move the same
  // pane, rather than each owning a private idea of which one is showing.
  await page.goto("/#workspace");
  await expect(page.locator(".workbench-activity")).toHaveClass(/mobile-active/u);
  await page.getByRole("tab", { name: /^Editor, 1 open documents$/u }).click();
  await expect(page.locator(".workbench-editor")).toHaveClass(/mobile-active/u);
  await page.getByRole("button", { name: "Close README.md" }).click();
  await page.goto("/#editor");
  await expect(page.locator(".workbench-activity")).toHaveClass(/mobile-active/u);
  await expect(page.getByRole("tree", { name: "Workspace files" })).toBeVisible();
});

test("a first paint at #editor with nothing open lands on the tree, not the dead pane", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile pane contract");
  // The other direction of the same rule, and the half no in-session journey
  // can reach: the arrival *effect* never runs on the first paint, so the pane
  // a cold load starts in is decided by the `useState` seed alone. Seeded as a
  // bare `useState(opensPane)` this landed on the editor pane with no document
  // and a disabled Editor tab — a screen whose only way out was the browser's
  // back button. So this test must not visit #workspace first; going through
  // `openIsolatedWorkspace` would mount the component on the good route and
  // prove nothing.
  await seedDisplayPreferences(page);
  await page.goto("/#editor");

  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  await expect(page.locator(".workbench-activity")).toHaveClass(/mobile-active/u);
  await expect(page.getByRole("tree", { name: "Workspace files" })).toBeVisible();
  // The pane it declined to open is genuinely unreachable, which is why
  // declining was the right answer rather than a cosmetic one.
  await expect(page.getByRole("tab", { name: "Editor", exact: true })).toBeDisabled();

  // And the rule is only about the empty case: open one document and #editor
  // means what it says.
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await page.goto("/#workspace");
  await expect(page.locator(".workbench-activity")).toHaveClass(/mobile-active/u);
  await page.goto("/#editor");
  await expect(page.locator(".workbench-editor")).toHaveClass(/mobile-active/u);
});
