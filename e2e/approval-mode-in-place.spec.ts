import { expect, test } from "@playwright/test";

/*
 * A name on the old behavior that had to die: changing the approval policy
 * minted a new pinned conversation — the mode control forked the reader's
 * thread as a side effect of a switch that reads as in-flight. Now one durable
 * journal event beside the manifest pin changes the mode in place, on the
 * conversation already open, and the next call is governed by it.
 */
test("switching the approval policy acts on the same thread, and only it", async ({ page }) => {
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.click();
  await composer.fill("name this thread approval-check");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".transcript")).toContainText("approval-check", { timeout: 20_000 });
  // Let the auto-rename land so nothing else writes to the head during the switch.
  await expect(page.locator(".transcript")).not.toHaveText(/new pinned conversation/u);

  const hashBefore = page.url();
  const trigger = page.locator(".composer-approval-select .menu-select-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole("option", { name: /Auto Approve/u }).click();

  // The status line says exactly what happened, in plain language, where the
  // person is looking. Mobile clips the element's line, so compare the full
  // text content rather than the rendered bounding box.
  const runtimeLine = page.locator(".runtime-line__text").first();
  await expect(runtimeLine).toContainText("Approval policy changed to Auto Approve for this conversation.", { timeout: 15_000 });
  await expect(runtimeLine).toContainText("The profile default for new conversations is unchanged.");

  // Same thread: the route did not move and no new conversation was minted.
  expect(page.url()).toBe(hashBefore);
  await expect(page.locator(".transcript")).not.toHaveText(/new pinned conversation/u);

  // The control itself now reflects the new mode — the next call is framed
  // by what the person sees, so what the person sees must be the new mode.
  await expect(page.locator(".composer-approval-select .menu-select-value")).toContainText(/Auto Approve/u);

  await page.goto("/#sessions", { waitUntil: "domcontentloaded" });
  const library = page.locator(".session-library-view");
  await expect(library).toBeVisible({ timeout: 15_000 });
  // One thread, not two. "Library grew by one pinned clone" was the old way.
  const conversationRows = library.getByRole("listitem");
  await expect(conversationRows).toHaveCount(1, { timeout: 15_000 });
  await expect(conversationRows.first()).toContainText("approval-check");
  await expect(conversationRows.first()).not.toContainText("· Auto Approve");
});
