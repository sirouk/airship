import { expect, test } from "@playwright/test";

/**
 * Typing `/` has to show the commands a first-time user needs.
 *
 * The registry exposes every tool as a slash command, so a bare `/` used to
 * fill all ten visible rows with the alphabetical head of the tool namespace —
 * `download_file` through `git-inspect` — and bury `/help`, `/models` and
 * `/sessions`, the three built-ins that exist nowhere else in the composer. The
 * placeholder says "/ for commands", so the menu was actively teaching that
 * those commands did not exist.
 *
 * The fix is two-part and this walks both halves in the browser, which is where
 * the truncation is actually experienced: built-ins outrank tools on a tie, and
 * the menu states how much of the set it is showing instead of stopping
 * silently at ten.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

test("a bare slash offers the built-in commands and states how many it is hiding", async ({ page }) => {
  await page.goto("/#chat");
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible();

  await composer.fill("/");
  const menu = page.locator(".slash-command-menu");
  // The registry closes over the tool registry and arrives with the deferred
  // command pack, so the first `/` of a cold page waits on a module load.
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await expect(menu).toHaveAttribute("role", "listbox");

  /*
   * The three built-ins by name. `/help` is the one the finding names first:
   * it sorts after `git-inspect`, so before the category tie-break it was
   * unreachable from the composer at any prefix shorter than `/h`.
   */
  for (const command of ["/help", "/models", "/sessions"]) {
    await expect(menu.getByRole("option", { name: command })).toHaveCount(1);
  }

  /*
   * The count, in both the sighted row and the listbox's accessible name — a
   * listbox may only own options, so the truncation fact cannot be a row.
   * `shown` is the visible slice and `total` the whole set; the assertion is
   * that they disagree and that the menu says so, because a list that stops at
   * ten without saying it stopped is what taught the wrong lesson.
   */
  const label = await menu.getAttribute("aria-label");
  const named = /^Available slash commands — showing (\d+) of (\d+)$/u.exec(label ?? "");
  expect(named, `listbox accessible name states the slice: ${label}`).not.toBeNull();
  const shown = Number(named![1]);
  const total = Number(named![2]);
  expect(shown).toBe(await menu.getByRole("option").count());
  expect(total).toBeGreaterThan(shown);
  await expect(menu.locator(".slash-command-menu__header")).toContainText(`${shown} of ${total}`);
});
