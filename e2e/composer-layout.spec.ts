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
  /*
   * These are 1px-tolerance geometry comparisons. Sampled the instant a value
   * changes they are correct in isolation and flaky under a loaded suite,
   * because a webfont or a still-settling layout can move a box by more than
   * the tolerance after the read. Waiting for fonts and for two animation
   * frames measures the settled layout the assertion is actually about, which
   * makes the test stricter rather than looser: a real drift still fails.
   */
  await page.evaluate(async () => {
    await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
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

/*
 * The regression this file watched happen.
 *
 * `menu-select.css` switches every popover to `position: fixed` below 640px;
 * `routes.css` overrode `inset` alone, so `calc(100% + …)` resolved against the
 * viewport and the menu opened at top: -164px — entirely off the screen — on
 * every phone. The suite stayed green because the assertion above reads
 * `toBeVisible()`, which a 400×156 box at a negative offset satisfies, and
 * because the trigger honestly reports `aria-expanded="true"` either way.
 *
 * So this asserts none of that. It asserts the three things a person actually
 * needs from the control that decides whether the agent writes files and runs
 * shell commands without asking: the options are *inside* the viewport, the
 * pixel under each option's centre belongs to that option (nothing is covering
 * it, and it is somewhere a thumb can land), and a tap changes the policy. The
 * label is measured too — below 380px it used to shed to a 1×1px clip, leaving
 * a bare coloured dot as the only statement of the agent's write posture.
 */
test("the approval policy opens inside the phone viewport, reads whole, and takes a tap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone geometry contract");

  for (const viewport of [
    { width: 430, height: 932 },
    { width: 360, height: 800 },
    { width: 932, height: 430 },
  ] as const) {
    const at = `${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    await page.goto("/#chat");
    const trigger = page.getByRole("button", { name: "Conversation approval policy" });
    await expect(trigger).toBeVisible();
    await page.getByRole("combobox", { name: "Message Airship" }).evaluate((element) => element.blur());

    const label = await page.evaluate(() => {
      const value = document.querySelector<HTMLElement>(".composer-approval-select .menu-select-value");
      const word = document.querySelector<HTMLElement>(".composer-approval-select .menu-select-value strong");
      return value && word
        ? { height: value.getBoundingClientRect().height, text: word.textContent ?? "", clipped: word.scrollWidth > word.clientWidth + 1 }
        : undefined;
    });
    expect(label, `${at}: the policy value renders`).toBeDefined();
    expect(label!.height, `${at}: policy value height`).toBeGreaterThanOrEqual(12);
    expect(label!.clipped, `${at}: policy value "${label!.text}" is not ellipsised`).toBe(false);

    // What the width came from, asserted so it cannot be taken back from the
    // wrong item. The strip buys the policy value its room by shedding the
    // attach control's *visible* label — a duplicate of its own input's
    // accessible name, which is why that shed costs nothing and is checked
    // here — and never by shedding the credential posture, which is a caveat
    // and stays on screen at every width the product supports.
    await expect(page.getByLabel("Attach image"), `${at}: attach control still names itself`).toHaveCount(1);
    await expect(page.locator(".composer-tools > span"), `${at}: credential posture stays visible`).toBeVisible();
    const caveat = await page.locator(".composer-tools > span").boundingBox();
    expect(caveat!.height, `${at}: credential posture is rendered, not clipped`).toBeGreaterThanOrEqual(12);

    await trigger.click();
    const geometry = await page.evaluate(() => {
      const popover = document.querySelector<HTMLElement>(".composer-approval-select .menu-select-popover");
      if (!popover) return undefined;
      const box = popover.getBoundingClientRect();
      return {
        popover: { top: box.top, right: box.right, bottom: box.bottom, left: box.left },
        viewport: { width: innerWidth, height: innerHeight },
        options: [...popover.querySelectorAll<HTMLElement>(".menu-select-option")].map((option) => {
          const bounds = option.getBoundingClientRect();
          const centre = document.elementFromPoint(
            Math.round(bounds.left + bounds.width / 2),
            Math.round(bounds.top + bounds.height / 2),
          );
          return {
            name: option.getAttribute("aria-label") ?? "",
            height: bounds.height,
            inside: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
            // The proof that "open" means reachable rather than merely laid
            // out: the compositor hands this pixel to this option.
            hittable: centre instanceof Element && centre.closest(".menu-select-option") === option,
          };
        }),
      };
    });

    expect(geometry, `${at}: the popover is mounted`).toBeDefined();
    expect(geometry!.popover.top, `${at}: popover top edge`).toBeGreaterThanOrEqual(0);
    expect(geometry!.popover.left, `${at}: popover left edge`).toBeGreaterThanOrEqual(0);
    expect(geometry!.popover.right, `${at}: popover right edge`).toBeLessThanOrEqual(geometry!.viewport.width + 1);
    expect(geometry!.popover.bottom, `${at}: popover bottom edge`).toBeLessThanOrEqual(geometry!.viewport.height + 1);
    expect(geometry!.options.map((option) => option.name), `${at}: every policy is offered`)
      .toEqual(["Ask First", "Auto Approve", "Full Access"]);
    for (const option of geometry!.options) {
      expect(option.inside, `${at}: "${option.name}" is inside the viewport`).toBe(true);
      expect(option.hittable, `${at}: "${option.name}" receives the pixel at its own centre`).toBe(true);
      expect(option.height, `${at}: "${option.name}" touch target`).toBeGreaterThanOrEqual(44);
    }

    // Reachability is only a claim until the tap lands and the policy changes.
    await page.getByRole("option", { name: "Full Access", exact: true }).click();
    await expect(trigger, `${at}: the selected policy`).toContainText("Full Access");
    await expect(page.getByRole("listbox", { name: "Conversation approval policy" })).toHaveCount(0);
  }
});
