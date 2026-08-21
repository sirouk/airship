import { expect, test, type Page } from "@playwright/test";

/**
 * Nothing a finger has to hit may be smaller than 44px on either axis.
 *
 * This is a measured contract rather than a source-grep because the defect it
 * exists to catch is invisible in source. Every control named below carried a
 * correct-looking rule: `.popover__trigger` had `min-height: 44px` under
 * `(pointer: coarse)`, and rendered 9×44 in the chat session bar at 390×844
 * because nothing floored its width. Reading the stylesheet would have passed
 * it. Only the rendered box tells the truth.
 *
 * Measured on the built tree before this landed — the model chip 9px wide,
 * pinned skills 14px, the journal chip 25px, the brand button 35px on all ten
 * routes, the terminal's full-view button 29px. A target's SMALLER dimension is
 * the one a fingertip has to find, which is why both axes are asserted.
 *
 * Deliberately not an allowlist. An allowlist of known-small controls is how a
 * floor becomes a suggestion: the list grows, nobody re-measures, and the rule
 * stops meaning anything. If a control genuinely cannot be 44px, the fix is to
 * give it a larger hit area, not to except it here.
 *
 * The floor is asserted only where the pointer is actually coarse — the mobile
 * project, which reports `isMobile`. `page.setViewportSize({ width: 320 })` was
 * measured and does NOT change the pointer type, so a narrow desktop page keeps
 * evaluating every `(pointer: coarse)` block to false. A floor asserted there
 * would be asserting a rule the browser was never applying, and would fail on
 * controls that are correct.
 */

/** Every route the shell can be addressed at. */
const ROUTES = [
  "chat", "sessions", "memory", "workspace", "editor",
  "access", "profiles", "vault",
  /*
   * `skills` joined when the route became writable. It was measurably under the
   * floor the whole time it was read-only: the global toggle is a
   * `role="switch"` button at 37px and the per-profile mode control is a
   * `.menu-select-trigger` at 38px, and the product-wide floor in `tokens.css`
   * only covers `.small-button` / `.icon-button` / `button.primary` / `.brand`.
   * The rule now lives beside the route's own styles; this is what proves it.
   */
  "skills",
  /*
   * `terminal`, `context` and `capabilities` were the last three the shell can
   * be addressed at and this list did not cover. Nothing distinguished them —
   * they were simply never added, and the audit that noticed measured the
   * terminal panel bar's Interrupt/Restart/Close at 95×30, 80×30 and 65×30 on a
   * phone while this file reported a clean sweep of eleven routes.
   *
   * Adding a route here has never once been free, which is the argument for the
   * list being complete rather than representative: `skills` exposed two
   * undersized controls the moment it joined.
   *
   * `context` is not a separate surface — it deep-links to Memory with the
   * workspace index open — and it is listed anyway, because "the same route in
   * a different opening state" is exactly the class of thing a goto-only sweep
   * misses.
   */
  "terminal", "context", "capabilities",
] as const;

/**
 * The states a `goto` never reaches — and they hold more controls than the
 * opening state does.
 *
 * The sweep above only ever navigated: no `fill`, no `type`, no `press`, and no
 * wait for a runtime to come up. So Memory's graph-match buttons, its per-hit
 * actions and its evidence disclosures — twenty-one controls, none of which
 * exist before a query settles — were outside the floor entirely, and so was
 * the terminal's Interrupt, which is rendered only while a shell is `running`
 * and is replaced by a status word for the second or two the route takes to
 * start one. Every one of those is a target a thumb has to find.
 *
 * Each state waits for the *result* rather than for a timeout: a sweep taken
 * while a query is in flight or a shell is still starting measures the empty
 * state and reports it clean, which is the failure mode this whole file exists
 * to refuse.
 */
const STATES_A_GOTO_NEVER_REACHES = [
  {
    route: "memory",
    state: "a settled memory search",
    async enter(page: Page) {
      await page.getByRole("searchbox", { name: "Search every memory surface" }).fill("workspace");
      // The graph section relabels itself for the query; that label is the
      // signal the matches have been computed and rendered.
      await expect(
        page.locator("#memory-relationships").getByText("Graph matches for “workspace”", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#memory-results").getByRole("status")).toBeVisible();
    },
  },
  {
    route: "sessions",
    state: "a filtered conversation library",
    async enter(page: Page) {
      const search = page.locator(".session-library-search input[type=search]");
      await search.fill("a");
      // The toolbar reports what the filter left, so the count settling is the
      // signal the list has re-rendered under the query.
      await expect(page.locator(".session-library-toolbar")).toBeVisible();
      await expect(search).toHaveValue("a");
    },
  },
  {
    route: "sessions",
    state: "the move-work panel open",
    async enter(page: Page) {
      /*
       * The panel is a separate chunk behind a control, so a `goto` sweep can
       * never reach it — and it is dense with targets a thumb has to find: a
       * checkbox row per conversation, two format radios, a memory toggle, a
       * file picker and two buttons. Exactly the class of surface this file
       * exists to measure rather than assume.
       */
      await page.getByRole("button", { name: "Move work" }).click();
      await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 30_000 });
    },
  },
  {
    route: "terminal",
    state: "a running shell",
    async enter(page: Page) {
      // Interrupt exists only in the `running` branch of the panel bar. The
      // route opens on `starting`, which is why the navigate-only sweep above
      // has never measured this control on any run.
      await expect(page.getByRole("button", { name: "Interrupt process" })).toBeVisible({ timeout: 30_000 });
    },
  },
] as const;

const FLOOR = 44;

/**
 * Every interactive box on the page, measured against the floor.
 *
 * Kept as one function so the queried sweep below cannot drift into a weaker
 * rule than the route sweep — two copies of a measurement is how one of them
 * quietly stops matching the other.
 */
async function undersizedControls(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((limit) => {
    const INTERACTIVE = "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=option],[role=switch]";
    return [...document.querySelectorAll(INTERACTIVE)].flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return [];
      /*
       * A visually-hidden control is not a target until it is focused.
       * Skip links and the file input behind "Attach image" are 1×1 by
       * design — the label wrapping them is what the finger lands on, and
       * that wrapper is measured on its own if it is interactive.
       */
      if (box.width <= 2 && box.height <= 2) return [];
      /*
       * The same principle, measured rather than assumed from a size. xterm's
       * `.xterm-helper-textarea` is a one-cell IME proxy parked under the
       * cursor at `opacity: 0; z-index: -5` — measured 9×23 at 390px inside a
       * running shell, invisible and behind the screen it belongs to. The
       * target a finger lands on is the emulator surface around it.
       *
       * This is a property anything can be measured for, not a name on a list:
       * a control at zero opacity is not a target at any size, and one that is
       * both invisible and interactive is a different defect than this file's.
       */
      const style = getComputedStyle(element);
      if (Number(style.opacity) === 0 || style.visibility === "hidden") return [];
      /*
       * An input inside a large label: the label is the target, because
       * clicking anywhere in it activates the control. A 18×18 checkbox in
       * a 308px label is not a small target.
       */
      const label = element.closest("label");
      if (label) {
        const wrapper = label.getBoundingClientRect();
        if (wrapper.width >= limit && wrapper.height >= limit) return [];
      }
      if (box.width >= limit && box.height >= limit) return [];
      const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40);
      return [`${Math.round(box.width)}×${Math.round(box.height)} <${element.tagName.toLowerCase()} class="${element.className}"> "${name}"`];
    });
  }, floor);
}

/** The route's own heading is the signal that its deferred chunk arrived. */
async function openRoute(page: Page, route: string, namespace: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#${route}`);
  // Measuring a skeleton would measure controls that are not there yet.
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
}

test.describe("touch targets meet the 44px floor on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the floor is a coarse-pointer rule");

  for (const route of ROUTES) {
    test(`${route} has no control under ${FLOOR}px on either axis`, async ({ page }) => {
      await openRoute(page, route, `touch-${route}`);
      const undersized = await undersizedControls(page, FLOOR);
      expect(undersized, `controls below the ${FLOOR}px floor on ${route}`).toEqual([]);
    });
  }

  for (const { route, state, enter } of STATES_A_GOTO_NEVER_REACHES) {
    test(`${route} has no control under ${FLOOR}px in ${state}`, async ({ page }) => {
      await openRoute(page, route, `touch-entered-${route}`);
      await enter(page);
      // Entering the state mounts new sections; let them lay out before they
      // are measured.
      await page.waitForTimeout(600);
      const undersized = await undersizedControls(page, FLOOR);
      expect(undersized, `controls below the ${FLOOR}px floor on ${route} in ${state}`).toEqual([]);
    });
  }
});
