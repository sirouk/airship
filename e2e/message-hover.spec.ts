import { expect, test } from "@playwright/test";

test("revealing message actions on hover does not change message or transcript geometry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "desktop hover layout contract");
  await page.goto("/#chat");
  const transcript = page.locator(".transcript");
  const message = page.locator("[data-transcript-card]").first();
  const actions = message.locator(".message-actions");

  await expect(message).toBeVisible();
  await expect(actions).toHaveCSS("opacity", "0");
  const messageBefore = await message.boundingBox();
  const transcriptBefore = await transcript.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(messageBefore).not.toBeNull();

  await message.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.waitForTimeout(150);
  const messageAfter = await message.boundingBox();
  const transcriptAfter = await transcript.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(messageAfter).not.toBeNull();

  await page.screenshot({ path: testInfo.outputPath("message-hover.png"), fullPage: true });
  expect(messageAfter!.height, "message height must remain stable when hover actions appear").toBeCloseTo(messageBefore!.height, 1);
  expect(messageAfter!.y, "message position must remain stable when hover actions appear").toBeCloseTo(messageBefore!.y, 1);
  expect(transcriptAfter, "transcript geometry must remain stable when hover actions appear").toEqual(transcriptBefore);
});

test("touch messages expose their actions as real, tappable targets", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "touch layout contract");
  await page.goto("/#chat");
  const message = page.locator("[data-transcript-card]").first();
  const copy = message.locator(".message-actions button").first();

  await expect(message).toBeVisible();
  // Touch has no hover, so the row is available without a disclosure step.
  await expect(copy).toBeVisible();
  const box = await copy.boundingBox();
  expect(box?.height, "touch targets stay at the 44px minimum").toBeGreaterThanOrEqual(44);
  await copy.click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the action row must scroll within itself rather than widen the document",
  ).toBe(true);
});

/**
 * The desktop path regressed silently once: the actions lived in a `<details>`
 * whose `<summary>` was hidden at pointer widths, so engines that stopped
 * painting closed-details content left every action laid out, measurable, and
 * permanently unclickable. Unit tests and the mobile contract above both
 * passed throughout. Assert reachability the way a person experiences it —
 * hover, click, and keyboard — not merely that the markup exists.
 */
test("pointer messages expose actions that can actually be clicked and tabbed to", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "pointer layout contract");
  await page.goto("/#chat");
  const message = page.locator("[data-transcript-card]").first();
  const copy = message.locator(".message-actions button", { hasText: "Copy" }).first();

  await expect(message).toBeVisible();
  await message.hover();
  await expect(copy).toBeVisible();

  const box = (await copy.boundingBox())!;
  expect(box.height, "a pointer target must stay large enough to hit").toBeGreaterThanOrEqual(20);
  expect(
    await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit instanceof HTMLButtonElement && (hit.textContent ?? "").includes("Copy");
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
    "the button itself must be the hit-test target at its own centre",
  ).toBe(true);

  await copy.click();

  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement?.tagName),
    "message actions must remain in the tab order for keyboard users",
  ).toBe("BUTTON");
});
