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

test("touch messages expose one stable action trigger instead of a permanent action rail", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "touch layout contract");
  await page.goto("/#chat");
  const message = page.locator("[data-transcript-card]").first();
  const menu = message.locator(".message-actions");
  const trigger = menu.locator("summary");

  await expect(message).toBeVisible();
  await expect(trigger).toBeVisible();
  const before = await message.boundingBox();
  await expect(trigger).toHaveAttribute("aria-label", "Open message actions");
  await trigger.click();
  await expect(menu.locator(":scope > div")).toBeVisible();
  const after = await message.boundingBox();
  expect(after?.height).toBeCloseTo(before?.height ?? 0, 1);
});
