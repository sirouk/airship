import { expect, test, type Page } from "@playwright/test";

/*
 * The three links a developer needs after the work is done.
 *
 * Measured before this spec existed: one workspace was described by three
 * mutually contradictory absolute paths in a single frame (chip "/workspace",
 * prompt "~/airship-node/airship-workspace", Git note "/workspace") while `ls
 * /workspace` failed in that shell; `git status` in the terminal dead-ended at
 * "jsh: command not found: git" with the bridge that answers it 200px below;
 * and a reload destroyed a confirmed commit while the route that lost it said
 * nothing at all.
 */

const EPHEMERAL_PREFERENCES = {
  mode: "dark",
  typeScale: "default",
  density: "comfortable",
  corners: "subtle",
  bodyFont: "system-sans",
  vaultBackend: "ephemeral",
  approvalMode: "full-access",
} as const;

async function openWorkbench(page: Page, hash: string): Promise<void> {
  await page.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify(preferences));
  }, EPHEMERAL_PREFERENCES);
  await page.goto(hash);
}

/**
 * Git verbs are the irreversible ones, so they are approved by a human here
 * whatever the stored preference says: the effective mode is the session's, and
 * an unpinned session asks first.
 */
async function allowOnce(page: Page, verb: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: `Allow ${verb} once?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Allow once" }).click();
  await expect(dialog).toHaveCount(0);
}

test("the terminal names one directory in both spellings, never a third", async ({ page }) => {
  await openWorkbench(page, "/#terminal");
  await expect(page.getByRole("heading", { name: "Terminal", level: 1 })).toBeVisible();

  // The bar leads with the path `pwd` prints inside the WebContainer, because
  // that is the shell whose chrome this is.
  const bar = page.locator(".terminal-panel__bar > div").first();
  await expect(bar.locator("code")).toHaveText("/home/airship-node/airship-workspace");
  // And it names the workspace spelling beside it rather than instead of it.
  await expect(bar.locator(".terminal-panel__mirror")).toHaveText("= /workspace");
  await expect(bar.locator(".sr-only")).toContainText(
    "/home/airship-node/airship-workspace in the shell is the same directory as /workspace in Explorer, the Editor and Source Control.",
  );

  const setup = page.locator("details.terminal-route__setup");
  if ((await setup.getAttribute("open")) === null) await setup.locator("summary").click();
  await expect(setup).toContainText("jsh has no git binary");
  await expect(setup).toContainText("BrowserGitClient");
  await expect(page.locator("form.terminal-git")).toHaveCount(0);
});

test("a commit that a reload destroys is named on the route that lost it", async ({ page }) => {
  await openWorkbench(page, "/#editor");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  // A cold workbench must not accuse itself of losing anything.
  await expect(page.locator(".workbench-lost-work")).toHaveCount(0);

  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: "Stage README.md" }).click();
  await allowOnce(page, "git_stage");
  const message = page.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeVisible();
  await message.fill("docs: persist marker");
  await page.getByRole("button", { name: "Commit staged" }).click();
  await allowOnce(page, "git_commit");
  await expect(page.locator(".scm-history")).toContainText("docs: persist marker");

  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();

  // The commit is genuinely gone — and now the route says so, naming it.
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await expect(page.locator(".scm-history")).toBeVisible();
  await expect(page.locator(".scm-history")).not.toContainText("docs: persist marker");
  const lost = page.locator(".workbench-lost-work");
  await expect(lost).toBeVisible();
  await expect(lost).toContainText("did not survive the reload");
  await expect(lost).toContainText("docs: persist marker");
  await expect(lost).toContainText("not recoverable");

  // It is a row in the workbench column, not an overlay lying on top of the
  // state it is describing.
  const notice = await lost.boundingBox();
  const panes = await page.locator(".workbench-shell").boundingBox();
  expect(notice && panes && notice.y + notice.height).toBeLessThanOrEqual((panes?.y ?? 0) + 1);

  // Leaving the route and coming back must not silently retire the claim: the
  // workbench unmounts on every navigation, and a sentence only the first mount
  // could say is a sentence nobody is guaranteed to read.
  await page.goto("/#chat");
  await page.goto("/#editor");
  await expect(page.locator(".workbench-lost-work")).toContainText("docs: persist marker");

  await page.locator(".workbench-lost-work").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".workbench-lost-work")).toHaveCount(0);
  // And dismissal is a decision, not a re-render away from being undone.
  await page.goto("/#chat");
  await page.goto("/#editor");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  await expect(page.locator(".workbench-lost-work")).toHaveCount(0);
});

/*
 * `git` in the terminal of a Git-capable product dead-ended in a raw shell
 * error while the bridge that answers it sat in a second form on the same
 * screen. Gated like every other test that needs a live WebContainer: this one
 * has to boot a real PTY to observe the submitted-line sideband.
 */
test("a submitted git line is answered inline by Airship Browser Git", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative live browser process");
  test.skip(process.env.AIRSHIP_LIVE_WEBCONTAINER !== "1", "Set AIRSHIP_LIVE_WEBCONTAINER=1 for the provider-backed live browser probe.");
  test.setTimeout(120_000);
  await openWorkbench(page, "/#terminal");
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" })).toBeVisible({ timeout: 90_000 });

  const emulator = page.locator(".terminal-emulator");
  const input = emulator.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  // The chip, the prompt and `pwd` are one string. This is the assertion the
  // three-contradictory-paths defect would have failed.
  const shellPath = "/home/airship-node/airship-workspace";
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText(shellPath, { timeout: 30_000 });
  await expect(page.locator(".terminal-panel__bar code").first()).toHaveText(shellPath);

  await input.focus();
  await page.keyboard.type("git status");
  await page.keyboard.press("Enter");
  const transcript = emulator.locator(".xterm-accessibility-tree");
  await expect(transcript).toContainText("Airship Browser Git", { timeout: 30_000 });
  await expect(transcript).toContainText("BrowserGitClient, not jsh");
  await expect(transcript).toContainText("On branch main");
  await expect(page.locator(".terminal-route__footer")).toContainText(
    "Airship Browser Git completed git status",
  );
  await expect(page.locator("form.terminal-git")).toHaveCount(0);
});
