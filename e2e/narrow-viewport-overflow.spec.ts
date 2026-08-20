import { expect, test } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

/*
 * No route may scroll sideways on a phone.
 *
 * Nothing covered widths below 390px. That is the iPhone 13 viewport the mobile
 * project happens to use, and a former route's tab row was sitting 2px inside
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
  "chat",
  "sessions",
  "workspace",
  "editor",
  "terminal",
  "memory",
  "context",
  "profiles",
  "capabilities",
  "skills",
  "vault",
  "access",
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
        /*
         * Inside every scrollport, not just up to the first one.
         *
         * The header comment above says a route-level assertion is silent about
         * anything behind an absorber, and then this loop asserted only at route
         * level anyway — so `.transcript` (which computes to `overflow-x: auto`
         * as a side effect of its `overflow-y: auto`) kept the whole class of
         * defect out of view. It was hiding a real one: a `/help` turn's slash
         * roster ran 85px past its column at 320px and scrolled the transcript
         * sideways by 57px, while `main.main` genuinely did not move and every
         * assertion here stayed green.
         *
         * The scrollports are discovered, never listed, because an allowlist is
         * how this went blind the first time. What separates a defect from a
         * design is not the scrollport — a chip strip and a transcript are
         * indistinguishable in the computed cascade, since CSS resolves the
         * unset axis of a scroll container to `auto` — it is what is inside it.
         * A strip of chips that scrolls is wider than its box in *aggregate*
         * and every chip in it fits. A paragraph, a list item or a heading that
         * is *itself* wider than the box it is reading in is text nobody can
         * read without dragging, and there is no layout in this product for
         * which that is the intent. Only those are reported, and only the
         * widest per scrollport, so the failure names its own source.
         */
        const absorbers = [...main.querySelectorAll<HTMLElement>("*")]
          .filter((element) => {
            const style = getComputedStyle(element);
            return (style.overflowX === "auto" || style.overflowX === "scroll")
              && element.scrollWidth - element.clientWidth > 1;
          })
          .flatMap((scrollport) => {
            const room = scrollport.clientWidth;
            const widest = [...scrollport.querySelectorAll<HTMLElement>("p,li,h1,h2,h3,h4")]
              .map((block) => ({
                what: `${scrollport.className || scrollport.tagName.toLowerCase()} › ${block.tagName.toLowerCase()}.${block.className}`,
                over: Math.round(block.getBoundingClientRect().width - room),
                text: (block.textContent ?? "").slice(0, 40),
              }))
              .filter((block) => block.over > 1)
              .sort((a, b) => b.over - a.over);
            return widest.slice(0, 1);
          });
        return {
          mainOverflow: main.scrollWidth - main.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
          absorbers,
        };
      });

      expect(geometry, `${route} renders a main region at ${width}px`).toBeDefined();
      // One pixel of slack absorbs subpixel rounding, and nothing more.
      if (geometry!.mainOverflow > 1 || geometry!.documentOverflow > 1) {
        overflowing.push(`${route}: main +${geometry!.mainOverflow}px, document +${geometry!.documentOverflow}px`);
      }
      for (const absorber of geometry!.absorbers) {
        overflowing.push(`${route}: ${absorber.what} is +${absorber.over}px wider than the scrollport holding it — "${absorber.text}"`);
      }
    }

    expect(overflowing, `routes overflowing at ${width}px`).toEqual([]);
  });
}

test("the live shared tab strip stays inside its 320px Workspace surface", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone widths are a mobile-project concern");
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/#workspace");

  const tabs = page.locator(".workbench-mobile-switch");
  await expect(tabs).toBeVisible();
  const tabButtons = tabs.locator(".tabs__tab-button");
  await expect(tabButtons).toHaveCount(3);

  const geometry = await tabs.evaluate((root) => {
    const surface = root.getBoundingClientRect();
    const strip = root.querySelector<HTMLElement>(".tabs__strip");
    const trigger = root.querySelector<HTMLElement>(".tabs__overflow-trigger");
    if (!strip) return undefined;
    return {
      surfaceLeft: surface.left,
      surfaceRight: surface.right,
      stripLeft: strip.getBoundingClientRect().left,
      stripRight: strip.getBoundingClientRect().right,
      stripClientWidth: strip.clientWidth,
      stripScrollWidth: strip.scrollWidth,
      buttonWidths: [...strip.querySelectorAll<HTMLElement>(".tabs__tab-button")]
        .map((button) => button.getBoundingClientRect().width),
      triggerLeft: trigger?.getBoundingClientRect().left,
      triggerRight: trigger?.getBoundingClientRect().right,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(geometry).toBeDefined();
  expect(geometry!.surfaceLeft).toBeGreaterThanOrEqual(-1);
  expect(geometry!.surfaceRight).toBeLessThanOrEqual(321);
  expect(geometry!.stripLeft).toBeGreaterThanOrEqual(geometry!.surfaceLeft - 1);
  expect(geometry!.stripRight).toBeLessThanOrEqual(geometry!.surfaceRight + 1);
  expect(geometry!.buttonWidths.every((width) => width >= 44)).toBe(true);
  expect(geometry!.documentOverflow).toBeLessThanOrEqual(1);

  // If all three labels do not fit, the shared primitive must expose its
  // overflow control inside the same surface rather than widening the page.
  if (geometry!.stripScrollWidth > geometry!.stripClientWidth + 1) {
    expect(geometry!.triggerLeft).toBeGreaterThanOrEqual(geometry!.surfaceLeft - 1);
    expect(geometry!.triggerRight).toBeLessThanOrEqual(geometry!.surfaceRight + 1);
  }
});

/*
 * The loop above cannot see this one, and that is the point.
 *
 * `.message-label` overflowed its column by 30px at 320px — measured, not
 * inferred: `scrollWidth 261` against `clientWidth 231` on the first assistant
 * turn, and `541` against `231` once a status chip joined the row. Every test
 * above passed throughout, because `.transcript` computes to `overflow-x: auto`
 * (a side effect of its `overflow-y: auto`) and absorbed all 282px before it
 * could reach `main.main`. An absorber between the source and the measured
 * element makes a route-level assertion silent about everything inside it.
 *
 * So this measures the row itself. Two chips were the source, both
 * `white-space: nowrap` flex items inheriting `min-width: auto`:
 * `.message-capability-tier` at 206.84px and `.message-status` at 269.75px,
 * each a min-content floor its 231px column could not satisfy.
 *
 * `/help` is the cheapest turn that renders all three chips at once and needs
 * no provider — the same handle `disconnected-capabilities` uses.
 */
test("no chip in a message label holds its column open at 320px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone widths are a mobile-project concern");
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/#chat");

  // The chips this geometry protects unmount at the house density rung —
  // minimal renders no capability pill, so there is nothing to measure.
  // Instrumented is the rung where they exist and are full-width, which is
  // precisely the case this assertion protects: a chip, measured, inside
  // its label's own column at the narrowest phone.
  await setProfilePresentationDensity(page, "Instrumented");
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/#chat");

  await page.getByRole("combobox", { name: "Message Airship" }).fill("/help");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message-capability-tier").last()).toBeVisible();
  // The status chip is the widest of the three and appears with the result.
  await expect(page.locator(".message-status").last()).toBeVisible();

  const rows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".message-label")).map((label) => {
    const column = label.getBoundingClientRect();
    return {
      selfOverflow: label.scrollWidth - label.clientWidth,
      // Every chip's own border box, against the column it is allowed to use.
      spill: Array.from(label.children)
        .map((child) => ({
          cls: String((child as HTMLElement).className) || child.tagName.toLowerCase(),
          over: Math.round((child.getBoundingClientRect().right - column.right) * 100) / 100,
        }))
        .filter((chip) => chip.over > 0.5),
    };
  }));

  expect(rows.length, "the transcript rendered labelled turns").toBeGreaterThan(0);
  expect(rows.filter((row) => row.selfOverflow > 1), "labels wider than their own column").toEqual([]);
  expect(rows.flatMap((row) => row.spill), "chips reaching past their label").toEqual([]);
});

/*
 * The other half of the same absorber, and the reason the spec above was scoped
 * to `.message-label` when it was written: its author measured the chips, fixed
 * the chips, and reported — against their own green result — that the *answer*
 * was still overflowing and they had not touched it.
 *
 * Measured at 320px on this build before the fix: `.transcript` reported 57px of
 * `scrollWidth` over `clientWidth` on a `/help` turn, with zero elements inside
 * any `.message-label` past their column. The source was a `<p>` in
 * `.message-body` holding `/deactivate-execution-runtime <runtime> |
 * /deactivate…`, 85px past its column, because that rule carried no
 * `overflow-wrap` while eleven other rules in the same sheet did. `main.main`
 * and the document both measured 0 throughout.
 *
 * So this measures the prose, and it measures it at the three widths the fix
 * had to be checked at: `overflow-wrap: break-word` is the narrower of the two
 * candidates precisely because `anywhere` participates in min-content sizing
 * and would start breaking ordinary sentences mid-word at comfortable widths.
 * 768 is here to catch that regression, not the overflow.
 */
for (const width of [320, 390, 768] as const) {
  test(`no message paragraph outruns its column at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "phone widths are a mobile-project concern");
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/#chat");

    await page.getByRole("combobox", { name: "Message Airship" }).fill("/help");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".message-status").last()).toBeVisible();

    const measured = await page.evaluate(() => {
      const transcript = document.querySelector<HTMLElement>(".transcript");
      if (!transcript) return undefined;
      const edge = transcript.getBoundingClientRect().right;
      return {
        // The absorber itself: the number the route loop structurally cannot see.
        transcriptOverflow: transcript.scrollWidth - transcript.clientWidth,
        spill: [...transcript.querySelectorAll<HTMLElement>("p")]
          .map((paragraph) => ({
            text: (paragraph.textContent ?? "").slice(0, 48),
            own: paragraph.scrollWidth - paragraph.clientWidth,
            past: Math.round((paragraph.getBoundingClientRect().right - edge) * 100) / 100,
          }))
          .filter((paragraph) => paragraph.own > 1 || paragraph.past > 0.5),
      };
    });

    expect(measured, "the transcript rendered").toBeDefined();
    expect(measured!.spill, `paragraphs wider than the transcript at ${width}px`).toEqual([]);
    expect(measured!.transcriptOverflow, `the transcript absorbed sideways scroll at ${width}px`).toBeLessThanOrEqual(1);
  });
}

/*
 * The fix that made the row fit must not shrink the one chip that is a target.
 *
 * Inside a message label the tier pill is a `<span>` — a legend. The transcript
 * intro renders the same recipe as a real `<button>` that opens Capabilities,
 * and `min-width: 0` on the shared class would have released the coarse-pointer
 * floor along with the layout floor. It does not, because
 * `button.message-capability-tier` in the `(pointer: coarse)` block carries one
 * more specificity point — but that is an argument, and this is the check.
 */
test("the intro tier button keeps its touch floor at 320px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone widths are a mobile-project concern");
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/#chat");

  /* The tier is telemetry in the density taxonomy: the house default
   * (minimal) does not render it at all. The floor it must keep applies at
   * the rungs where it exists, so the measurement runs one rung up. */
  await setProfilePresentationDensity(page, "Balanced");
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/#chat");

  const tier = page.locator("button.transcript-intro__tier");
  await expect(tier).toBeVisible();
  const box = (await tier.boundingBox())!;
  expect(box.width, "tier button width").toBeGreaterThanOrEqual(44);
  expect(box.height, "tier button height").toBeGreaterThanOrEqual(44);
});
