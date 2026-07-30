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
  top: number;
  right: number;
  bottom: number;
  left: number;
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
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    /*
     * Two frames were enough for a font, but not for a transition. The composer
     * animates its height now, so clearing a multi-line draft leaves the box
     * mid-collapse: the flake was a 136px difference, not a sub-pixel one. Poll
     * until the height stops moving instead of guessing a frame count — this
     * measures the settled layout the assertion is about, and a genuine drift
     * still fails because the value it settles on is the one compared.
     */
    const measured = [".composer", '[aria-label="Message Airship"]',
      '.composer-approval-select .menu-select-trigger', ".composer-attach", ".composer-footer"];
    const geometry = () => measured.map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "-";
    }).join("|");
    // Every box the assertions compare, not just the composer: the footer and
    // the approval trigger settle on their own schedules, so polling one of
    // them left the others mid-transition and the failing test varied by run.
    let previous = "";
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await frame();
      const current = geometry();
      if (current === previous) return;
      previous = current;
    }
  });
  return page.evaluate(() => {
    const snapshot = (element: Element): DOMRectSnapshot => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      };
    };
    return {
      composer: snapshot(document.querySelector(".composer")!),
      textarea: snapshot(document.querySelector('[aria-label="Message Airship"]')!),
      // Anchored on the class, not the accessible name: the name states the
      // control's scope in prose and is free to be reworded, and an exact
      // attribute selector silently returns null when it is.
      approval: snapshot(document.querySelector(".composer-approval-select .menu-select-trigger")!),
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
  await expect(menu.getByRole("option", { name: "Full Access", exact: true })).toContainText("Allow every effect without prompting, including requests to any HTTPS origin.");
  const disclosed = await readComposerGeometry(page);
  expectNear(disclosed.composer.height, multiline.composer.height, "open policy disclosure: composer height");
  expectApprovalAnchored(disclosed, multiline, "open policy disclosure");

  await page.keyboard.press("Escape");
  /*
   * Wait for the listbox to hand focus back before clearing.
   *
   * `MenuSelect` restores focus to its trigger inside a `requestAnimationFrame`
   * so the closing panel is gone before the ring moves. That frame ends in a
   * render, and a render of a controlled textarea re-applies the value in state
   * — so a `fill("")` issued inside the same frame had its DOM write reverted
   * about half the time, and the twelve lines came back. Escape-then-clear is
   * one frame apart for a person and zero for a driver; this waits for the
   * boundary the product actually defines rather than sleeping through it.
   */
  await expect(approval).toBeFocused();
  await textarea.fill("");
  // Preact reconciles the controlled value after the browser's input event.
  // Establish that boundary before measuring its layout; otherwise a loaded
  // suite can sample the previous twelve-line value while the fill is settling.
  await expect(textarea).toHaveValue("");
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
    await expect(page.locator(".composer-posture"), `${at}: credential posture stays visible`).toBeVisible();
    const caveat = await page.locator(".composer-posture").boundingBox();
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
            /*
             * The word a person reads off the option, taken from the option's
             * own contents. This used to read `aria-label`, and that attribute
             * is deliberately gone: `MenuSelect` names each option *from* its
             * contents now, so a screen reader announces the text that is on
             * screen instead of a parallel string that could drift from it.
             * Reading the rendered word is therefore the stronger read — and
             * the computed accessible name is asserted separately below, so
             * both halves of the naming contract are still covered.
             */
            name: option.querySelector(".menu-select-option-copy strong")?.textContent?.trim() ?? "",
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
    const policies = ["Ask First", "Auto Approve", "Full Access"] as const;
    expect(geometry!.options.map((option) => option.name), `${at}: every policy is offered`)
      .toEqual(policies);

    /*
     * And each option is *called* by the word it shows. Two assertions where
     * there was one: the read above proves the word is rendered, this one
     * proves the accessible name the browser computes for the same option
     * equals it exactly — so the description sentence stays out of the name
     * (it is announced via `aria-describedby`), and a reader hears "Auto
     * Approve", not "Auto Approve Ask the active model to review each effect".
     * An `aria-label` read could never have caught that regression, because
     * folding the sentence into the contents leaves the attribute untouched.
     */
    const offered = page.getByRole("listbox", { name: "Conversation approval policy" }).getByRole("option");
    await expect(offered, `${at}: three policies in the accessibility tree`).toHaveCount(policies.length);
    for (const [index, policy] of policies.entries()) {
      await expect(offered.nth(index), `${at}: accessible name of policy ${index + 1}`).toHaveAccessibleName(policy);
    }

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

/**
 * A `visualViewport` the test can move, installed before the app boots.
 *
 * Chromium has no soft keyboard to open, so the alternative was to write the
 * offset onto `:root` by hand — which asserts the stylesheet against a value
 * the test itself invented and skips the code that decides whether to publish
 * at all. Substituting the *source* keeps the whole path real: the app's own
 * `useVisualViewport` reads these numbers, computes the obscured height, writes
 * the variable and re-anchors the transcript, and every box measured below is
 * one the browser laid out.
 *
 * `innerHeight` stays the browser's, because that is exactly the fact the
 * layout has to cope with: a keyboard does not shrink the layout viewport, and
 * pretending otherwise is the bug this file exists to catch.
 */
async function installMovableVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class MovableVisualViewport extends EventTarget {
      obscured = 0;
      zoom = 1;
      get width() { return window.innerWidth; }
      get height() { return window.innerHeight - this.obscured; }
      get offsetTop() { return 0; }
      get offsetLeft() { return 0; }
      get pageTop() { return 0; }
      get pageLeft() { return 0; }
      get scale() { return this.zoom; }
    }
    const viewport = new MovableVisualViewport();
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
    Object.defineProperty(window, "__airshipViewport", { configurable: true, get: () => viewport });
  });
}

/** Moves the fake viewport and waits out the publisher's `requestAnimationFrame`. */
async function setObscuredHeight(page: Page, obscured: number, scale = 1): Promise<void> {
  await page.evaluate(async ([pixels, zoom]) => {
    const viewport = (window as unknown as { __airshipViewport: { obscured: number; zoom: number } & EventTarget }).__airshipViewport;
    viewport.obscured = pixels!;
    viewport.zoom = zoom!;
    viewport.dispatchEvent(new Event("resize"));
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    // One frame for the publisher's own rAF, one for the layout it triggers.
    await frame();
    await frame();
  }, [obscured, scale]);
}

type ShellGeometry = Readonly<{
  innerHeight: number;
  overflow: number;
  published: string;
  keyboardOpen: string;
  app: DOMRectSnapshot;
  transcript: DOMRectSnapshot;
  composerWrap: DOMRectSnapshot;
  lastCard: DOMRectSnapshot;
  navVisible: boolean;
}>;

async function readShellGeometry(page: Page): Promise<ShellGeometry> {
  return page.evaluate(() => {
    const snapshot = (element: Element): DOMRectSnapshot => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    };
    const cards = document.querySelectorAll("[data-transcript-card]");
    const nav = document.querySelector<HTMLElement>(".mobile-nav");
    return {
      innerHeight: window.innerHeight,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      published: document.documentElement.style.getPropertyValue("--visual-viewport-bottom"),
      keyboardOpen: document.documentElement.dataset.keyboardOpen ?? "",
      app: snapshot(document.querySelector("#app")!),
      transcript: snapshot(document.querySelector(".transcript")!),
      composerWrap: snapshot(document.querySelector(".composer-wrap")!),
      lastCard: snapshot(cards.item(cards.length - 1)!),
      navVisible: nav !== null && nav.getBoundingClientRect().height > 0,
    };
  });
}

/*
 * The defect, stated as geometry.
 *
 * The compensation that shipped was `position: relative; bottom: <obscured>` on
 * `.composer-wrap` plus a matching `padding-bottom` on `.transcript`. Both are
 * paint-only: a relative inset moves a painted box without vacating the track
 * it came from, and padding only buys scrollable extent *below* a card that is
 * still hidden. So the composer appeared to rise while the transcript's
 * border-box floor stayed at the foot of the layout viewport — behind the
 * keyboard — and every anchor that measures against that floor
 * (`scrollToLastRealCard`, `isNearLastRealCard`, the responsive geometry specs)
 * was measuring a line the reader cannot see. Worse, collapsing the nav's grid
 * track pushed that floor a further 56px *down*, so re-anchoring against it
 * moved the newest card deeper under the composer than doing nothing.
 *
 * Only a browser can answer whether a box moved, which is why this is here and
 * not in `platform-shell.test.ts`: that file pins the publisher's decisions
 * against a modelled floor, and `composer-shell-contract.test.ts` pins the rule
 * that moves it. This measures the pixels.
 */
test("the soft keyboard shortens the shell and keeps the last card on a floor the reader can see", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone soft-keyboard contract");
  await installMovableVisualViewport(page);
  await page.goto("/#chat");
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Explain the runtime posture in one sentence.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("[data-transcript-card]").last()).toBeVisible({ timeout: 30_000 });

  const resting = await readShellGeometry(page);
  expect(resting.keyboardOpen, "no keyboard at rest").toBe("false");
  expect(resting.navVisible, "the nav band is on screen at rest").toBe(true);
  expectNear(resting.app.height, resting.innerHeight, "resting shell height");

  const obscured = 290;
  await setObscuredHeight(page, obscured);
  const open = await readShellGeometry(page);

  expect(open.published, "the obscured height is published").toBe(`${obscured}px`);
  expect(open.keyboardOpen).toBe("true");
  expect(open.navVisible, "the nav band leaves the layout, not just the paint").toBe(false);
  // The shell — not the composer's paint — is what shrank.
  expectNear(open.app.height, resting.innerHeight - obscured, "shell shortened to the visual viewport");
  expect(open.composerWrap.bottom, "the composer is above the keyboard").toBeLessThanOrEqual(resting.innerHeight - obscured + 1);
  // The assertion the paint-only compensation could never satisfy: the
  // transcript's own floor is above the composer, so a card resting on it is
  // a card in front of the keyboard rather than behind it.
  expect(open.transcript.bottom, "transcript floor sits above the composer").toBeLessThanOrEqual(open.composerWrap.top + 1);
  expect(open.transcript.height, "the transcript keeps usable height").toBeGreaterThanOrEqual(80);
  expect(open.overflow, "opening the keyboard introduces no horizontal overflow").toBeLessThanOrEqual(1);

  // Re-anchored, and re-anchored the right way: the newest card is on the
  // shortened floor and inside the box, not pushed further down it.
  expect(open.lastCard.bottom).toBeLessThanOrEqual(open.transcript.bottom + 1);
  expect(open.lastCard.bottom).toBeGreaterThan(open.transcript.top);

  // Pinch zoom moves `height` and `offsetTop` the same way a keyboard does.
  // Compensating for it would shrink the shell around a reader mid-gesture and
  // scroll the transcript under their finger, so nothing may change.
  await setObscuredHeight(page, obscured + 120, 2);
  const zoomed = await readShellGeometry(page);
  expect(zoomed.published, "a pinch publishes nothing").toBe(`${obscured}px`);
  expectNear(zoomed.app.height, open.app.height, "pinch: shell height unchanged");
  expectNear(zoomed.transcript.bottom, open.transcript.bottom, "pinch: transcript floor unchanged");

  await setObscuredHeight(page, 0);
  const closed = await readShellGeometry(page);
  expect(closed.keyboardOpen).toBe("false");
  expect(closed.navVisible, "the nav band comes back").toBe(true);
  // Resting geometry is restored exactly, not approximately: the compensation
  // is a variable that returns to 0, never a layout the shell has to undo.
  expectNear(closed.app.height, resting.app.height, "shell height restored");
  expectNear(closed.transcript.bottom, resting.transcript.bottom, "transcript floor restored");
  expectNear(closed.composerWrap.bottom, resting.composerWrap.bottom, "composer restored");
  expect(closed.lastCard.bottom).toBeLessThanOrEqual(closed.transcript.bottom + 1);
});

/*
 * The fade over a scrolled draft.
 *
 * `.composer-input-row[data-scrolled] textarea` is a two-file contract — the
 * dataset is written by the composer's scroll listener in `app.tsx`, the mask
 * by `chat.css` — and it shipped with a `.composer` step in the selector that
 * inverted the real nesting, so the mask never applied and a scrolled draft
 * showed a half-sliced line with no indication it was scrolled.
 * `composer-shell-contract.test.ts` pins the selector against the markup;
 * only a browser can say whether the mask is actually painted, which is what
 * this reads out of the computed style.
 */
test("a draft scrolled past the composer's growth cap is faded at the edge it runs past", async ({ page }) => {
  await page.goto("/#chat");
  const textarea = page.getByRole("combobox", { name: "Message Airship" });
  await expect(textarea).toBeVisible();
  await textarea.fill(Array.from({ length: 24 }, (_, line) => `Bounded draft line ${line + 1}`).join("\n"));
  // `fill()` leaves the caret at the end, and browsers legitimately scroll a
  // textarea to keep that caret visible. This phase is explicitly the top
  // edge, so put the field there and emit the same event a user scroll emits.
  await textarea.evaluate((field) => {
    field.scrollTop = 0;
    field.dispatchEvent(new Event("scroll"));
  });

  const read = async () => page.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Airship"]')!;
    const row = document.querySelector<HTMLElement>(".composer-input-row")!;
    const style = getComputedStyle(field);
    return {
      state: row.dataset.scrolled ?? "",
      // Chromium reports the standard property; the prefixed one is what the
      // sheet would have to fall back to, and a silent "none" is the failure.
      mask: style.maskImage === "none" || style.maskImage === ""
        ? (style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage ?? "none"
        : style.maskImage,
      overflowing: field.scrollHeight > field.clientHeight + 1,
      scrollTop: field.scrollTop,
      maxScroll: field.scrollHeight - field.clientHeight,
    };
  });

  const atTop = await read();
  expect(atTop.overflowing, "24 lines overflow the growth cap").toBe(true);
  expect(atTop.state, "content below the fold").toBe("bottom");
  expect(atTop.mask, "the bottom edge is faded").toContain("gradient");

  await page.locator('[aria-label="Message Airship"]').evaluate((field) => {
    const box = field as HTMLTextAreaElement;
    box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 2);
    box.dispatchEvent(new Event("scroll"));
  });
  const middle = await read();
  expect(middle.state, "content above and below the fold").toBe("both");
  expect(middle.mask, "both edges are faded").toContain("gradient");

  await page.locator('[aria-label="Message Airship"]').evaluate((field) => {
    const box = field as HTMLTextAreaElement;
    box.scrollTop = box.scrollHeight;
    box.dispatchEvent(new Event("scroll"));
  });
  const bottom = await read();
  expect(bottom.state, "content above the fold only").toBe("top");
  expect(bottom.mask, "the top edge is faded").toContain("gradient");

  // Unscrolled again: no mask, so a one-line draft is never dimmed.
  await textarea.fill("Plan");
  const cleared = await read();
  expect(cleared.state).toBe("");
  expect(cleared.mask).toBe("none");
});

/*
 * Attachment chips mount conditionally, so they were absent from every screen
 * the phone touch-floor pass was captured against and kept a 28px destructive
 * control — remove this attachment — in a row of 44px siblings. The rule exists
 * in `routes.css`; nothing rendered the markup it selects, which is why this
 * mounts a real attachment rather than reading the sheet.
 */
test("a mounted attachment chip meets the phone touch floor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone touch-target contract");
  await page.goto("/#chat");
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible();

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "airship-touch-floor.png",
    mimeType: "image/png",
    // A valid 96×96 opaque PNG, shared with the vision smoke test: a 1×1 input
    // is a legal PNG but is below the preview pipeline's useful floor.
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAjUlEQVR42u3QMQEAAAQAMCTRP5MwEnhdW4TldAe3UiBIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEEIEiRIkCBBggQJQpAgQYIECRIkCEGCBAkSJEiQIAQJEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEgQggQJEiRIkCBBghAkSJAgQYIECUKQIEF/FlLTAdyKtVlSAAAAAElFTkSuQmCC", "base64"),
  });

  const chip = page.locator(".composer-attachments > span");
  await expect(chip).toHaveCount(1);
  const remove = chip.getByRole("button", { name: /^Remove / });
  const box = await remove.boundingBox();
  expect(box, "the remove control is laid out").not.toBeNull();
  expect(box!.height, "removing an attachment is destructive and must be a full touch target").toBeGreaterThanOrEqual(44);
  expect(box!.width, "remove control width").toBeGreaterThanOrEqual(44);

  // A target that is 44px and covered is still unreachable, so the pixel at
  // its centre has to belong to it — and the tap has to actually remove.
  const hittable = await remove.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const centre = document.elementFromPoint(Math.round(bounds.left + bounds.width / 2), Math.round(bounds.top + bounds.height / 2));
    return centre instanceof Element && (centre === element || element.contains(centre));
  });
  expect(hittable, "the remove control receives the pixel at its own centre").toBe(true);
  await remove.click();
  await expect(page.locator(".composer-attachments")).toHaveCount(0);
});
