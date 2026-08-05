import { expect, test, type Page } from "@playwright/test";

/**
 * The empty transcript is an intro panel now, not a seeded message card, so a
 * test about message chrome has to produce a real message first. The local
 * demo provider answers deterministically with no credential, which keeps this
 * a layout contract rather than a provider test.
 */
async function seedOneTurn(page: Page) {
  await page.goto("/#chat");
  await page.getByRole("combobox", { name: "Message Airship" }).fill("hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("[data-transcript-card]").first()).toBeVisible({ timeout: 30_000 });
}

async function denyClipboardWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText() {
          throw new DOMException("Write permission denied.", "NotAllowedError");
        },
      },
    });
  });
}

test("revealing message actions on hover does not change message or transcript geometry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "desktop hover layout contract");
  await seedOneTurn(page);
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
  const contentBox = await message.locator(".message-body > p").first().boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(actionsBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height);
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

test("touch messages expose one calm action trigger and tappable actions", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "touch layout contract");
  await denyClipboardWrites(page);
  await seedOneTurn(page);
  const message = page.locator("[data-transcript-card]").first();
  const trigger = message.locator('summary[aria-label="Message actions"]');

  await expect(message).toBeVisible();
  await expect(message.locator(".message-actions")).toBeHidden();
  await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox?.height, "touch disclosure stays at the 44px minimum").toBeGreaterThanOrEqual(44);
  await trigger.click();
  const copy = message.getByRole("group", { name: "Message actions" }).getByRole("button", { name: "Copy" });
  await expect(copy).toBeVisible();
  const box = await copy.boundingBox();
  expect(box?.height, "touch targets stay at the 44px minimum").toBeGreaterThanOrEqual(44);
  await copy.click();
  await expect(message.getByRole("alert"))
    .toContainText("Select the message text and use your browser's Copy command.");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the action row must scroll within itself rather than widen the document",
  ).toBe(true);
});

/**
 * The touch trigger carried `role="button"` — added only to suppress the
 * disclosure triangle, which `list-style: none` and the
 * `::-webkit-details-marker` rule already do — and its actions were wrapped in
 * `role="menu"`/`role="menuitem"`. Both were role overrides rather than widget
 * contracts: the first erased the native details expanded state, so the trigger
 * announced nothing about being open or closed, and the second promised menu
 * keyboard semantics (focus on open, roving tabindex, arrows, Escape) that no
 * code implemented. The plain-buttons-in-a-named-group form has to keep every
 * action reachable on touch, which is what the roles were never checked for.
 */
test("touch action disclosure reports its expanded state and keeps every action reachable", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "touch layout contract");
  await seedOneTurn(page);
  // The user card exists from the first paint; Retry only exists on an answer.
  await expect(page.locator('[data-transcript-card][data-message-role="assistant"]').last())
    .toBeVisible({ timeout: 30_000 });

  const reachable = [
    { role: "user", actions: ["Copy", "Edit & branch", "Fork from here"] },
    { role: "assistant", actions: ["Copy", "Retry", "Fork from here"] },
  ] as const;

  for (const { role, actions } of reachable) {
    const card = page.locator(`[data-transcript-card][data-message-role="${role}"]`).last();
    const disclosure = card.locator("details.message-actions-touch");
    const trigger = disclosure.locator("summary");

    // No role on the summary: the override is what cost the native mapping.
    await expect(trigger).not.toHaveAttribute("role");
    await expect(disclosure).toHaveJSProperty("open", false);
    await trigger.click();
    await expect(disclosure).toHaveJSProperty("open", true);

    // A menu role here would be a contract nothing in this subtree honours.
    await expect(disclosure.locator('[role="menu"], [role="menuitem"]')).toHaveCount(0);
    const group = disclosure.getByRole("group", { name: "Message actions" });
    for (const name of actions) {
      await expect(group.getByRole("button", { name }), `${role} · ${name}`).toBeEnabled();
    }
    // Collapsing again is the other half of the disclosure the roles removed.
    await trigger.click();
    await expect(disclosure).toHaveJSProperty("open", false);
  }
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
  await denyClipboardWrites(page);
  await seedOneTurn(page);
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
  await expect(message.getByRole("alert"))
    .toContainText("Select the message text and use your browser's Copy command.");

  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement?.tagName),
    "message actions must remain in the tab order for keyboard users",
  ).toBe("BUTTON");
});
