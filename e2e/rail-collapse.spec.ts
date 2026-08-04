import { expect, test, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/*
 * The collapsed rail, driven rather than read.
 *
 * Measured on this build before the fix, at 1440x1000 with four conversations
 * and `data-rail="rail"`: the rail is 60px wide, and `.recent-conversations`
 * was still an ordinary in-flow grid inside it. Every conversation row measured
 * 67.4px starting at x=13 — 20px past the rail's own right edge — and the title
 * element reported `clientWidth: 29` against `scrollWidth: 132`. "General
 * conversation" printed as "Ge", the timestamp as "2", the "RECENT" group label
 * as "RECE", and `All conversations` as a 306px-wide empty bordered box with no
 * glyph and no text at all. 290px of a 60px rail spent saying nothing.
 *
 * No spec caught it because no spec had ever collapsed the rail and looked at
 * what the rail then said. These do, and they assert the two properties a
 * collapse owes: at rest it is an icon strip that fits inside itself and still
 * states its counts, and on click it gives every word back at a width that
 * holds it.
 */

async function seedConversations(page: Page, count: number): Promise<void> {
  const session = page.getByRole("region", { name: "Agent session" });
  for (let index = 0; index < count; index += 1) {
    await session.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
  }
}

async function collapseRail(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Collapse navigation rail" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.rail)).toBe("rail");
  // Off the rail, so the hover-peek is not what is being measured. Focus is
  // deliberately left where the click put it — on `.rail-collapse`, inside the
  // sidebar — because that is the state a person is actually in one moment
  // after pressing collapse, and it is the state the peek used to reopen in.
  await page.mouse.move(900, 500);
}

test("the collapsed rail is an icon strip that fits inside itself and still counts its conversations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail is display:none below the phone breakpoint");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await seedConversations(page, 3);
  await collapseRail(page);

  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    const bar = sidebar.getBoundingClientRect();
    const overflowing = [...sidebar.querySelectorAll<HTMLElement>(".nav-item, .recent-conversation-row, .rail-recents__header")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > bar.right + 0.5;
      })
      .map((element) => element.className);
    const clipped = [...sidebar.querySelectorAll<HTMLElement>(".recent-conversation__copy strong, .rail-conversation-group")]
      .filter((element) => element.scrollWidth > element.clientWidth + 0.5)
      .map((element) => element.textContent);
    return { railWidth: bar.width, overflowing, clipped };
  });

  // 60px is the rail token; the point is that everything drawn is inside it.
  expect(geometry.railWidth).toBeLessThanOrEqual(84);
  expect(geometry.overflowing).toEqual([]);
  // Before the fix this was ["General conversation", …, "Recent"].
  expect(geometry.clipped).toEqual([]);

  /*
   * Nothing removed: the rail still states how many conversations this profile
   * has, without being opened and without room for the sentence that says it.
   */
  const badge = page.locator(".rail-recents__badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("4");
  await expect(page.getByRole("button", { name: "Expand recent conversations" }))
    .toHaveAttribute("title", /4 in this profile/u);

  // Every destination survives the collapse — this is a narrower rail, not a
  // shorter product. Their names moved into `title`, which carries the scope
  // the visible label never did.
  const primary = page.getByRole("navigation", { name: "Primary" });
  for (const destination of ["Chat", "Workspace", "Memory", "Proof", "Vault", "Connection", "Account"] as const) {
    await expect(primary.getByRole("button", { name: destination, exact: true })).toHaveCount(1);
  }

  /*
   * The collapse is not paid for by the keyboard. Pressing the control leaves
   * focus on it, and the peek must not treat that as "a keyboard user is
   * reading labels" — but a real keyboard traversal still must. So: focus the
   * Proof row the way the keyboard does, and the labels come back.
   */
  const railWidthNow = () => page.locator(".sidebar .rail").evaluate((rail) => rail.getBoundingClientRect().width);
  expect(await railWidthNow()).toBeLessThanOrEqual(84);
  await primary.getByRole("button", { name: "Proof", exact: true }).evaluate((button: HTMLElement) => {
    button.focus({ focusVisible: true } as FocusOptions);
  });
  await page.keyboard.press("ArrowUp");
  await expect.poll(railWidthNow).toBeGreaterThan(200);
  await expect(primary.getByRole("button", { name: "Proof", exact: true }).locator(".nav-item__label")).toBeVisible();
});

test("the collapsed rail opens its conversations beside itself, at a width that holds their titles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail is display:none below the phone breakpoint");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await seedConversations(page, 3);
  const openedUrl = page.url();
  await collapseRail(page);

  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("button", { name: "Expand recent conversations" }).click();
  const panel = page.locator("#airship-recent-conversations");
  await expect(panel).toBeVisible();

  const opened = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!.getBoundingClientRect();
    const rect = document.querySelector<HTMLElement>("#airship-recent-conversations")!.getBoundingClientRect();
    const titles = [...document.querySelectorAll<HTMLElement>("#airship-recent-conversations .recent-conversation__copy strong")]
      .map((title) => ({ text: title.textContent, clipped: title.scrollWidth > title.clientWidth + 0.5 }));
    return { railWidth: sidebar.width, panel: { left: rect.left, width: rect.width }, titles };
  });

  // It hangs off the rail rather than inside it: the rail is still collapsed
  // and the panel is wider than the rail it belongs to.
  expect(opened.railWidth).toBeLessThanOrEqual(84);
  expect(opened.panel.width).toBeGreaterThanOrEqual(300);
  expect(opened.panel.left).toBeGreaterThanOrEqual(opened.railWidth);

  // The words are all back, none of them cut.
  expect(opened.titles).toHaveLength(4);
  for (const title of opened.titles) {
    expect(title.text).toBe("General conversation");
    expect(title.clipped).toBe(false);
  }

  // Including the ledger link, which was rendering as an empty bordered box:
  // the row was there, the string was in the DOM, and the icon rail's
  // label clip had reduced it to a 1px square inside a 306px button.
  const allConversations = panel.getByRole("button", { name: "All conversations" });
  await expect(allConversations).toBeVisible();
  await expect(allConversations).toContainText("All conversations");
  expect(await allConversations.locator(".nav-item__label").evaluate((label) => label.getBoundingClientRect().width))
    .toBeGreaterThan(60);

  /*
   * And the journey the rail exists for still completes from the collapsed
   * state: pick a conversation out of the panel and land in that conversation,
   * not merely in "a" conversation.
   */
  const target = panel.locator(".recent-conversation-row").last();
  const targetId = await target.getAttribute("data-session-id");
  expect(targetId).toBeTruthy();
  expect(openedUrl).not.toContain(String(targetId));
  await target.locator(".recent-conversation--thread").click();
  await expect(page).toHaveURL(new RegExp(`#chat/${String(targetId)}$`, "u"));

  /*
   * Restoring the rail restores the list in place. It is one panel in two
   * homes rather than two lists that can disagree: the same node, with the
   * flyout placement dropped, back inside the 232px rail.
   */
  await page.getByRole("button", { name: "Expand navigation rail" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.rail)).toBe("standard");
  const expand = primary.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
  const restored = page.locator("#airship-recent-conversations");
  await expect(restored).toBeVisible();
  expect(await restored.evaluate((element) => element.getAttribute("data-flyout"))).toBeNull();
  await expect(restored.locator(".recent-conversation-row")).toHaveCount(4);
});
