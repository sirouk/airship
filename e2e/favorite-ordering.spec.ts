import { expect, test, type Locator, type Page } from "@playwright/test";

test("desktop reorders profile favorites by pointer and keyboard without moving recents", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop favorite ordering contract");
  await page.goto("/#chat");
  await renameConversation(page, "Favorite Alpha", false);

  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expandConversations(page);
  let tree = navigation.getByRole("group", { name: "Profile conversations" });
  await tree.getByRole("button", { name: "Add to favorites Favorite Alpha" }).click();

  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await renameConversation(page, "Favorite Beta", false);
  await expandConversations(page);
  tree = navigation.getByRole("group", { name: "Profile conversations" });
  await tree.getByRole("button", { name: "Add to favorites Favorite Beta" }).click();
  await expect.poll(() => favoriteTitles(tree, ".recent-conversation-row")).toEqual(["Favorite Alpha", "Favorite Beta"]);

  const beta = tree.locator('.recent-conversation-row[data-favorite="true"]', { hasText: "Favorite Beta" });
  const alpha = tree.locator('.recent-conversation-row[data-favorite="true"]', { hasText: "Favorite Alpha" });
  await beta.dragTo(alpha);
  await expect.poll(() => favoriteTitles(tree, ".recent-conversation-row")).toEqual(["Favorite Beta", "Favorite Alpha"]);

  // A real button is the keyboard/touch-independent fallback; activating it
  // with Enter exercises the same append-only move path as Alt+ArrowUp.
  await tree.getByRole("button", { name: "Move favorite Favorite Alpha up" }).press("Enter");
  await expect.poll(() => favoriteTitles(tree, ".recent-conversation-row")).toEqual(["Favorite Alpha", "Favorite Beta"]);

  await tree.getByRole("button", { name: "All conversations", exact: true }).click();
  const ledger = page.getByRole("list", { name: "Available conversations" });
  await expect.poll(() => favoriteTitles(ledger, ".session-library-row")).toEqual(["Favorite Alpha", "Favorite Beta"]);
  const ledgerAlpha = ledger.locator('.session-library-row[data-favorite="true"]', { hasText: "Favorite Alpha" });
  const ledgerBeta = ledger.locator('.session-library-row[data-favorite="true"]', { hasText: "Favorite Beta" });
  await ledgerAlpha.dragTo(ledgerBeta);
  await expect.poll(() => favoriteTitles(ledger, ".session-library-row")).toEqual(["Favorite Beta", "Favorite Alpha"]);

  /*
   * A Profile switch restores that Profile's own cockpit, which lands on Chat.
   * The ledger has to be reopened under each Profile before it can be read —
   * asserting against an unmounted route would pass for the wrong reason, and
   * "Research sees no favorites" is only meaningful with Research's ledger open.
   */
  const profile = page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" });
  await profile.click();
  await page.getByRole("listbox", { name: "Agent profile" }).getByRole("option", { name: "Research", exact: true }).click();
  await openAllConversations(page);
  await expect(ledger.getByText("Favorite Alpha", { exact: true })).toHaveCount(0);
  await expect(ledger.locator('[data-favorite="true"]')).toHaveCount(0);
  await profile.click();
  await page.getByRole("listbox", { name: "Agent profile" }).getByRole("option", { name: "General", exact: true }).click();
  await openAllConversations(page);
  await expect.poll(() => favoriteTitles(ledger, ".session-library-row")).toEqual(["Favorite Beta", "Favorite Alpha"]);
});

test("mobile exposes explicit favorite move controls in All Conversations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile favorite ordering contract");
  await page.goto("/#chat");
  await renameConversation(page, "Mobile Favorite Alpha", true);
  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await renameConversation(page, "Mobile Favorite Beta", true);

  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: "All conversations" }).click();
  const ledger = page.getByRole("list", { name: "Available conversations" });
  await ledger.getByRole("button", { name: "Add to favorites Mobile Favorite Alpha" }).click();
  await ledger.getByRole("button", { name: "Add to favorites Mobile Favorite Beta" }).click();
  await expect.poll(() => favoriteTitles(ledger, ".session-library-row")).toEqual(["Mobile Favorite Alpha", "Mobile Favorite Beta"]);

  const moveUp = ledger.getByRole("button", { name: "Move favorite Mobile Favorite Beta up" });
  await expect(moveUp).toBeVisible();
  await moveUp.click();
  await expect.poll(() => favoriteTitles(ledger, ".session-library-row")).toEqual(["Mobile Favorite Beta", "Mobile Favorite Alpha"]);
  await expect(ledger.getByRole("button", { name: "Move favorite Mobile Favorite Beta up" })).toBeDisabled();
});

/*
 * Idempotent: the Chat disclosure stays open across creating a conversation, so
 * a second unconditional "Expand" click waits forever on a control that now
 * reads "Collapse".
 */
async function openAllConversations(page: Page): Promise<void> {
  await expandConversations(page);
  await page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "All conversations", exact: true }).click();
  await expect(page.getByRole("list", { name: "Available conversations" })).toBeVisible();
}

async function expandConversations(page: Page): Promise<void> {
  const primary = page.getByRole("navigation", { name: "Primary" });
  const expand = primary.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
  await expect(primary.getByRole("group", { name: "Profile conversations" })).toBeVisible();
}

async function renameConversation(page: Page, title: string, mobile: boolean): Promise<void> {
  // One control, two gestures: a coarse pointer taps the title, a mouse
  // double-clicks it. The phone's separate pencil button is gone — it was a
  // second control for the verb that acts on the element beside it, on the row
  // that also has to hold the conversation's name.
  if (mobile) await page.locator(".session-bar__identity-button").tap();
  else await page.locator(".session-bar__identity-button").dblclick();
  const input = page.getByRole("textbox", { name: "Conversation title" });
  await input.fill(title);
  await input.press("Enter");
  await expect(page.locator(".session-bar__title")).toHaveText(title);
}

async function favoriteTitles(container: Locator, rowSelector: string): Promise<string[]> {
  return container.locator(`${rowSelector}[data-favorite="true"] .recent-conversation__copy strong, ${rowSelector}[data-favorite="true"] .session-library-card-top strong`)
    .allTextContents()
    .then((titles) => titles.map((title) => title.trim()));
}
