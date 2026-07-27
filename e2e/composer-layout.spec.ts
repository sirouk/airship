import { expect, test, type Page } from "@playwright/test";

type ComposerGeometry = Readonly<{
  composer: DOMRectSnapshot;
  textarea: DOMRectSnapshot;
  approval: DOMRectSnapshot;
  attach: DOMRectSnapshot;
  footer: DOMRectSnapshot;
}>;

type DOMRectSnapshot = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}>;

async function readComposerGeometry(page: Page): Promise<ComposerGeometry> {
  return page.evaluate(() => {
    const snapshot = (element: Element): DOMRectSnapshot => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    return {
      composer: snapshot(document.querySelector(".composer")!),
      textarea: snapshot(document.querySelector('[aria-label="Message Airship"]')!),
      approval: snapshot(document.querySelector('[aria-label="Conversation approval policy"]')!),
      attach: snapshot(document.querySelector(".composer-attach")!),
      footer: snapshot(document.querySelector(".composer-footer")!),
    };
  });
}

function expectNear(actual: number, expected: number, message: string, tolerance = 1): void {
  expect(Math.abs(actual - expected), message).toBeLessThanOrEqual(tolerance);
}

function expectApprovalAnchored(actual: ComposerGeometry, expected: ComposerGeometry, phase: string): void {
  expectNear(actual.approval.x, expected.approval.x, `${phase}: approval x`);
  expectNear(actual.approval.bottom, expected.approval.bottom, `${phase}: approval bottom`);
  expectNear(actual.footer.bottom, expected.footer.bottom, `${phase}: footer bottom`);
  expectNear(actual.composer.right, expected.composer.right, `${phase}: composer right`);
  expectNear(actual.composer.bottom, expected.composer.bottom, `${phase}: composer bottom`);
}

test("composer focus, hover, and one-line typing do not move approval controls", async ({ page }) => {
  await page.goto("/#chat");
  const textarea = page.getByRole("combobox", { name: "Message Airship" });
  const approval = page.getByRole("button", { name: "Conversation approval policy" });
  await expect(textarea).toBeVisible();
  await expect(approval).toContainText("Ask First");
  await expect(page.getByLabel("Attach image")).toHaveCount(1);

  await textarea.evaluate((element) => element.blur());
  await page.mouse.move(1, 1);
  const resting = await readComposerGeometry(page);
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 640) {
    expect(resting.approval.height, "mobile approval touch target").toBeGreaterThanOrEqual(44);
    expect(resting.attach.height, "mobile attachment touch target").toBeGreaterThanOrEqual(44);
  }

  await textarea.focus();
  const focused = await readComposerGeometry(page);
  expectNear(focused.composer.height, resting.composer.height, "focus: composer height");
  expectNear(focused.textarea.height, resting.textarea.height, "focus: textarea height");
  expectApprovalAnchored(focused, resting, "focus");

  await textarea.fill("Plan");
  const typed = await readComposerGeometry(page);
  // §7.2 amendment. The band is deleted, so the sentence is asserted where
  // it now lives: verbatim in the permanently-mounted sr-only description
  // Send points at, and again on the model chip, whose accessible name
  // says what is actually answering. Stronger than the band assertion —
  // the band unmounted the moment a provider connected and its id could
  // dangle mid-render, while this target has the same lifetime as the
  // `aria-describedby` reference asserted three lines below.
  await expect(page.locator("#chat-demo-guidance"))
    .toHaveText("Chat needs a model provider; this composer is a deterministic demo.");
  await expect(page.locator(".session-model-chip")).toHaveAttribute("aria-label", /Demo/u);
  await expect(page.getByRole("button", { name: "Send message" }))
    .toHaveAttribute("title", "Deterministic local demo response. Connect a model for real inference.");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("aria-describedby", "chat-demo-guidance");
  expectNear(typed.composer.height, resting.composer.height, "one-line input: composer height");
  expectNear(typed.textarea.height, resting.textarea.height, "one-line input: textarea height");
  expectApprovalAnchored(typed, resting, "one-line input");

  await approval.hover();
  const hovered = await readComposerGeometry(page);
  expectNear(hovered.composer.height, typed.composer.height, "hover: composer height");
  expectApprovalAnchored(hovered, typed, "hover");
});

test("composer growth is content-driven, bounded, and keeps approval disclosure anchored", async ({ page }) => {
  await page.goto("/#chat");
  const textarea = page.getByRole("combobox", { name: "Message Airship" });
  const approval = page.getByRole("button", { name: "Conversation approval policy" });
  await expect(textarea).toBeVisible();

  await textarea.fill("Plan");
  const oneLine = await readComposerGeometry(page);
  await textarea.fill([
    "First bounded line",
    "Second bounded line",
    "Third bounded line",
    "Fourth bounded line",
    "Fifth bounded line",
    "Sixth bounded line",
    "Seventh bounded line",
    "Eighth bounded line",
    "Ninth bounded line",
    "Tenth bounded line",
    "Eleventh bounded line",
    "Twelfth bounded line",
  ].join("\n"));
  const multiline = await readComposerGeometry(page);

  expect(multiline.composer.height).toBeGreaterThan(oneLine.composer.height + 30);
  expect(multiline.textarea.height).toBeLessThanOrEqual(181);
  expect(multiline.textarea.height).toBeGreaterThan(100);
  expectApprovalAnchored(multiline, oneLine, "multiline input");

  await approval.click();
  const menu = page.getByRole("listbox", { name: "Conversation approval policy" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "Ask First", exact: true })).toContainText("Prompt before effectful actions.");
  await expect(menu.getByRole("option", { name: "Auto Approve", exact: true })).toContainText("Ask the active model to review each effect; prompt when uncertain.");
  await expect(menu.getByRole("option", { name: "Full Access", exact: true })).toContainText("Allow effects inside the bounded browser workspace without prompting.");
  const disclosed = await readComposerGeometry(page);
  expectNear(disclosed.composer.height, multiline.composer.height, "open policy disclosure: composer height");
  expectApprovalAnchored(disclosed, multiline, "open policy disclosure");

  await page.keyboard.press("Escape");
  await textarea.fill("");
  const cleared = await readComposerGeometry(page);
  expectNear(cleared.composer.height, oneLine.composer.height, "cleared input: composer height");
  expectApprovalAnchored(cleared, oneLine, "cleared input");

  // The immutable-conversation switch is comparatively expensive on mobile;
  // the same fixed-width trigger CSS is already measured above there.
  if ((page.viewportSize()?.width ?? 0) > 640) {
    for (const policy of ["Auto Approve", "Full Access", "Ask First"] as const) {
      await approval.click();
      await page
        .getByRole("listbox", { name: "Conversation approval policy" })
        .getByRole("option", { name: policy, exact: true })
        .click();
      await expect(approval).toContainText(policy);
      const switched = await readComposerGeometry(page);
      expectNear(switched.approval.width, cleared.approval.width, `${policy}: approval width`);
      expectApprovalAnchored(switched, cleared, `${policy} selection`);
    }
  }
});
