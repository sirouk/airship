import { expect, test } from "@playwright/test";

test("imports a real public GitHub snapshot into workspace and browser Git", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one live network contract is sufficient");
  test.setTimeout(120_000);

  const isolatedNamespace = `airship-live-v2/e2e/github-import-${Date.now()}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(isolatedNamespace)}#editor`);
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repositories & worktrees" })).toBeVisible();
  await page.getByRole("button", { name: /Import public GitHub snapshot/ }).click();

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
  await expect(page.locator(".git-repository-meta")).toContainText("octocat/Hello-World");
  await expect(page.getByRole("list", { name: "Changed paths" })).toContainText("README");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace" }).click();
  await page.getByRole("treeitem", { name: new RegExp(`${destinationName}$`) }).click();
  await expect(page.getByRole("treeitem", { name: /^README /u })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Editor" }).click();
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(page.locator(".git-repository-meta")).toContainText("octocat/Hello-World");

  const changes = page.getByRole("list", { name: "Changed paths" });
  await changes.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Stage selected", exact: true }).click();
  await page.getByRole("dialog", { name: /Allow git_stage once/ }).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/staged · added/).first()).toBeVisible();

  await page.getByLabel("Message").fill("Admit pinned public snapshot");
  await page.getByRole("button", { name: "Commit locally" }).click();
  await page.getByRole("dialog", { name: /Allow git_commit once/ }).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Commit created locally. Nothing was pushed.")).toBeVisible();
  await expect(page.getByText(/changed path/)).toBeVisible();
  const committedHead = await page.locator(".git-repository-meta > span").innerText();

  await page.reload();
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Editor" }).click();
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(page.locator(".git-repository-meta")).toContainText("octocat/Hello-World");
  await expect(page.locator(".git-repository-meta > span")).toHaveText(committedHead);
  await expect(page.getByRole("list", { name: "Changed paths" })).toBeVisible();
});
