import { expect, test } from "@playwright/test";

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
 */

/** Every route the shell can be addressed at. */
const ROUTES = [
  "chat", "sessions", "memory", "workspace", "editor",
  "attestations", "billing", "access", "profiles", "vault",
  /*
   * `skills` joined when the route became writable. It was measurably under the
   * floor the whole time it was read-only: the global toggle is a
   * `role="switch"` button at 37px and the per-profile mode control is a
   * `.menu-select-trigger` at 38px, and the product-wide floor in `tokens.css`
   * only covers `.small-button` / `.icon-button` / `button.primary` / `.brand`.
   * The rule now lives beside the route's own styles; this is what proves it.
   */
  "skills",
] as const;

const FLOOR = 44;

test.describe("touch targets meet the 44px floor on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the floor is a coarse-pointer rule");

  for (const route of ROUTES) {
    test(`${route} has no control under ${FLOOR}px on either axis`, async ({ page }) => {
      await page.goto(`/?airshipLabNamespace=touch-${route}#${route}`);
      // The route's own heading is the signal that the deferred chunk arrived;
      // measuring a skeleton would measure controls that are not there yet.
      await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);

      const undersized = await page.evaluate((floor) => {
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
           * An input inside a large label: the label is the target, because
           * clicking anywhere in it activates the control. A 18×18 checkbox in
           * a 308px label is not a small target.
           */
          const label = element.closest("label");
          if (label) {
            const wrapper = label.getBoundingClientRect();
            if (wrapper.width >= floor && wrapper.height >= floor) return [];
          }
          if (box.width >= floor && box.height >= floor) return [];
          const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40);
          return [`${Math.round(box.width)}×${Math.round(box.height)} <${element.tagName.toLowerCase()} class="${element.className}"> "${name}"`];
        });
      }, FLOOR);

      expect(undersized, `controls below the ${FLOOR}px floor on ${route}`).toEqual([]);
    });
  }
});
