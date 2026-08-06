import { expect, test } from "@playwright/test";

test("imports a real public GitHub snapshot into workspace and browser Git", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one live network contract is sufficient");
  test.setTimeout(120_000);
  await enableLocalLabVault(page);

  const isolatedNamespace = `airship-live-v2/e2e/github-import-${Date.now()}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(isolatedNamespace)}#editor`);
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await openAdvancedSourceControls(page);
  await expect(page.getByRole("heading", { name: "Repositories & worktrees" })).toBeVisible();
  await openImportPanel(page);

  await page.getByLabel("GitHub repository").fill("octocat/Hello-World");
  const destinationName = `hello-world-${Date.now()}`;
  await page.getByLabel("Import destination").fill(`/workspace/sources/${destinationName}`);
  await page.getByRole("button", { name: "Review & import" }).click();

  const approval = page.getByRole("dialog", { name: /Allow github_snapshot_import once/ });
  await expect(approval).toContainText("api.github.com");
  await expect(approval).toContainText("history");
  await approval.getByRole("button", { name: "Allow once" }).click();

  const receipt = page.getByRole("article", { name: "GitHub snapshot import receipt" });
  await expect(receipt).toBeVisible({ timeout: 90_000 });
  await expect(receipt).toContainText("octocat/Hello-World");
  await expect(receipt).toContainText("Not imported");
  await expect(receipt.locator("dd").filter({ hasText: /^[0-9a-f]{40}$/ })).toBeVisible();
  await expectRepositoryReady(page, "octocat/Hello-World");
  await expect(page.getByRole("tab", { name: /^Changes, 0 changed paths$/u })).toBeVisible();
  await expect(page.getByText("Nothing to stage", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close advanced source controls" }).click();

  // `exact` is required now that the rail carries an `Expand/Collapse Workspace`
  // sibling: a substring match resolves to both the destination and its
  // disclosure. The destination asserted is the same one as before.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("treeitem", { name: new RegExp(`${destinationName}$`) }).click();
  await expect(page.getByRole("treeitem", { name: /^README /u })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /^\.git(?:\s|$)/u })).toHaveCount(0);
  await page.getByRole("treeitem", { name: /^README /u }).dblclick();
  const importedReadme = page.getByRole("textbox", { name: "Edit README" });
  await importedReadme.fill("A local edit after a clean snapshot baseline.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await openEditorRoute(page);
  await openAdvancedSourceControls(page);
  await expectRepositoryReady(page, "octocat/Hello-World");

  const changes = page.getByRole("list", { name: "Changed paths" });
  await changes.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Stage selected", exact: true }).click();
  await page.getByRole("dialog", { name: /Allow git_stage once/ }).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/staged · modified/).first()).toBeVisible();

  await page.getByLabel("Message").fill("Update imported snapshot locally");
  await page.getByRole("button", { name: "Commit locally" }).click();
  await page.getByRole("dialog", { name: /Allow git_commit once/ }).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Commit created locally. Nothing was pushed.")).toBeVisible();
  // AMENDED: `N changed paths` is no longer a separate visible sentence; the
  // count now rides with the Changes tab's label as plain text and its unit
  // lives in that tab's accessible name (`sources-view.tsx:460` feeding
  // `tabAccessibleName`). Nothing was dropped — the number and the word for
  // what it counts are both still readable. Asserting the accessible name is
  // stronger than the old free-text search: a bare unlabelled badge would have
  // satisfied `getByText(/changed path/)` elsewhere on the page but fails here.
  await expect(page.getByRole("tab", { name: /changed paths/u }))
    .toHaveAccessibleName(/^Changes, \d+ changed paths$/u);
  // The head has to be read with the controls open. Inside a closed `<details>`
  // the node is not rendered and `innerText` answers "", which would have made
  // the post-reload durability comparison below trivially true.
  await openRepositoryControls(page);
  const committedHead = await page.locator(".git-repository-meta > span").innerText();
  expect(committedHead, "the committed head is a real short oid").toMatch(/^[0-9a-f]{7,40}$/u);

  const linkedBranch = `feature/browser-linked-${Date.now()}`;
  const linkedPath = `/workspace/worktrees/${destinationName}-linked`;
  await page.getByLabel("New branch").fill(linkedBranch);
  await page.getByRole("button", { name: "Create branch" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(`Created local branch ${linkedBranch}.`)).toBeVisible();

  await page.getByLabel("Worktree branch").fill(linkedBranch);
  await page.getByLabel("Workspace path").fill(linkedPath);
  await page.getByRole("button", { name: "Create worktree" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(`Created worktree for ${linkedBranch}.`)).toBeVisible();
  // AMENDED: the `Repository and worktree selection` aside is now the
  // `git-repository-controls` disclosure, whose summary states the repository,
  // the checked-out branch, the short head and the worktree count before it is
  // opened. Both facts this asserted — the linked branch and its workspace
  // path — are unchanged and still rendered together; naming the worktree list
  // instead of the whole aside is narrower and therefore stricter, since the
  // strings can no longer be satisfied by an unrelated corner of the rail.
  const worktreeRail = page.locator("details.git-repository-controls .git-worktree-list");
  await expect(worktreeRail).toContainText(linkedBranch);
  await expect(worktreeRail).toContainText(linkedPath);

  await page.reload();
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await openEditorRoute(page);
  await openAdvancedSourceControls(page);
  await expectRepositoryReady(page, "octocat/Hello-World");
  await expect(page.locator(".git-repository-meta > span")).toHaveText(committedHead);
  await openRepositoryControls(page);
  await expect(page.locator("details.git-repository-controls .git-worktree-list")).toContainText(linkedBranch);
  await expect(page.getByText("Nothing to stage", { exact: true })).toBeVisible();
});

// AMENDED: the snapshot importer is no longer a resting button whose label is
// the panel's title. It is an `Import` toggle in the Sources route bar, and
// "Import public GitHub snapshot" is now the heading of the panel it opens
// (`sources-view.tsx:379`, `:417`). Driving the toggle and then asserting both
// its expanded state and the panel's own title is stronger than the old single
// click: the collapse must announce itself AND still name what it contains, so
// an importer hidden behind an unlabelled or non-committing control fails here.
async function openImportPanel(page: import("@playwright/test").Page): Promise<void> {
  // The trigger renames itself to `Close import` while open, so the locator has
  // to admit both names — and asserting the rename is part of the point: the
  // control states which way it will move.
  const toggle = page.getByRole("button", { name: /^(?:Import|Close import)$/u });
  await expect(toggle).toHaveAccessibleName("Import");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Close import");
  await expect(page.getByRole("region", { name: "Import public GitHub snapshot" })).toBeVisible();
}

async function openAdvancedSourceControls(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: "Advanced source controls" }).click();
  await expect(page.getByRole("dialog", { name: "Advanced source controls" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Repositories & worktrees" })).toBeVisible();
}

// AMENDED: the branch, worktree and checkout controls rest inside a `<details>`
// that self-opens only past one worktree (`sources-view.tsx:533`). Asserting the
// summary still names every fact it holds before opening it keeps this spec a
// check on the collapse, not just a way past it.
async function openRepositoryControls(page: import("@playwright/test").Page): Promise<void> {
  const controls = page.locator("details.git-repository-controls");
  await expect(controls.locator("summary")).toContainText(/worktree/u);
  await expect(controls.locator("summary")).toContainText(/branch, worktree and checkout controls/u);
  // `getAttribute("open")` answers "" on an open `<details>`, which is falsy —
  // testing it directly would click a disclosure that is already open and close
  // it. The live `open` property is the only honest reading, and the route
  // self-opens this one once a repository has more than one worktree.
  if (!(await controls.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await controls.locator("summary").click();
  }
  await expect(controls).toHaveJSProperty("open", true);
}

// AMENDED: `Editor` sits behind the rail's Workspace expander now. Everything
// this spec then asserts on the route is unchanged.
async function openEditorRoute(page: import("@playwright/test").Page): Promise<void> {
  const primary = page.getByRole("navigation", { name: "Primary" });
  const expander = primary.getByRole("button", { name: "Expand Workspace" });
  if (await expander.count()) await expander.click();
  await primary.getByRole("button", { name: "Editor", exact: true }).click();
}

async function enableLocalLabVault(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
}

async function expectRepositoryReady(page: import("@playwright/test").Page, name: string): Promise<void> {
  // A real Workspace-backed status walk may be sharing the local MinIO lab
  // with another acceptance lane. Wait on the observable completion boundary,
  // not a fixed sleep or a synthetic repository fixture.
  await expect(page.locator(".git-repository-meta")).toContainText(name, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Refresh repositories" })).toBeEnabled({ timeout: 30_000 });
}
