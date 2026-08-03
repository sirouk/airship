import { expect, test } from "@playwright/test";

/*
 * No route may scroll sideways on a phone.
 *
 * Nothing covered widths below 390px. That is the iPhone 13 viewport the mobile
 * project happens to use, and the Proof route's tab row was sitting 2px inside
 * it — 375px of buttons in a 377px column — which is a coincidence of one
 * machine's font metrics rather than a layout. On the Linux runner those labels
 * measure wider and `route-adversarial-audit` reported 8px of overflow that
 * would not reproduce on macOS.
 *
 * The fix was `min-width: 0` on the tab row. This spec is the guard: a flex or
 * grid item defaults to `min-width: auto`, so it silently refuses to shrink
 * below its own min-content and reports a box wider than its column no matter
 * what `max-width` says. That failure is invisible at the one width the suite
 * measured, so it needs more than one width.
 *
 * 360, 375 and 390 are covered because they are what people hold: 375 is the
 * iPhone SE and 13 mini, 360 is the common Android width.
 *
 * 320px is covered too, and it took three failed attempts to earn. `#memory` and
 * `#context` overflowed 13px there, and `min-width: 0` on the route header, on
 * its bar, and `minmax(0, 1fr)` on both route grids all changed the number by
 * nothing — because those elements were victims rather than sources. The real
 * floor was `repeat(auto-fit, minmax(320px, 1fr))` on the result lanes: an
 * unsatisfiable fixed track minimum inside a 294px content box, propagating up
 * and stretching every sibling to match. A second floor sat three pixels
 * underneath it and only appeared once a query was typed.
 *
 * 320px is the narrowest viewport worth asserting: it is the floor every
 * responsive baseline has used since the original iPhone, and no shipping phone
 * is narrower.
 */

const ROUTES = [
  "proof",
  "vault",
  "chat",
  "editor",
  "sessions",
  "memory",
  "workspace",
  "terminal",
  "access",
  "capabilities",
  "context",
  "billing",
] as const;

// The widths people actually hold, plus the responsive floor.
const PHONE_WIDTHS = [320, 360, 375, 390] as const;

for (const width of PHONE_WIDTHS) {
  test(`no route scrolls sideways at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "phone widths are a mobile-project concern");
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 812 });

    const overflowing: string[] = [];
    for (const route of ROUTES) {
      await page.goto(`/#${route}`);
      await page.locator("main.main").waitFor({ state: "visible", timeout: 20_000 });
      // Let the route settle: several of these mount their panels asynchronously
      // and a measurement taken mid-mount reports a narrower tree than ships.
      await page.waitForTimeout(300);

      const geometry = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("main.main");
        if (!main) return undefined;
        return {
          mainOverflow: main.scrollWidth - main.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });

      expect(geometry, `${route} renders a main region at ${width}px`).toBeDefined();
      // One pixel of slack absorbs subpixel rounding, and nothing more.
      if (geometry!.mainOverflow > 1 || geometry!.documentOverflow > 1) {
        overflowing.push(`${route}: main +${geometry!.mainOverflow}px, document +${geometry!.documentOverflow}px`);
      }
    }

    expect(overflowing, `routes overflowing at ${width}px`).toEqual([]);
  });
}
