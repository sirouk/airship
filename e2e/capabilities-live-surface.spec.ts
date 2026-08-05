import { expect, test, type Locator } from "@playwright/test";

/*
 * The two claims about Airship's live-load reading that only a browser can
 * settle, plus the phone touch-target sweep the same finding asked for.
 *
 * The unit suites next to the components assert the wording, the counting and
 * the mount points as source facts, which is the repo's convention and is what
 * keeps those guarantees cheap to check. They cannot answer three questions:
 * whether the element is actually in the rendered DOM of a route that is not
 * #capabilities, whether anything is left in the accessibility tree once the
 * decorative glyphs are hidden, and whether a `summary` really measures 44px on
 * a 390px screen. Those are geometry and tree facts, so they are asserted here.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

/**
 * The text a screen reader would be left with: the region's children minus the
 * ones removed from the accessibility tree.
 *
 * This is the assertion the earlier shape failed. `role="status"` announces its
 * accessible contents, and the first build marked *both* children
 * `aria-hidden="true"` under an `aria-label` — so a change from Idle to
 * 2 running announced nothing and browse mode landed on an empty container.
 */
async function accessibleReading(indicator: Locator): Promise<string> {
  return (await indicator.evaluate((element) => [...element.children]
    .filter((child) => child.getAttribute("aria-hidden") !== "true")
    .map((child) => child.textContent ?? "")
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()));
}

test("the live-load reading is on routes that are not #capabilities, and says what it counted", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "rail geometry contract");
  // Two non-#capabilities destinations, which is the criterion verbatim: the
  // finding was that the only live reading in the product lived on the route a
  // reader has to navigate to in order to ask "what is running right now".
  for (const hash of ["chat", "memory"] as const) {
    await page.goto(`/#${hash}`);
    const indicator = page.locator('.load-indicator[data-placement="rail"]');
    await expect(indicator).toBeVisible();
    // The count is a count, not a meter: no percentage, no bar, no ratio.
    await expect(indicator.locator(".load-indicator__count")).toHaveText(/^\d+$/u);
    await expect(indicator).not.toContainText("%");

    const reading = await accessibleReading(indicator);
    expect(reading, `${hash} leaves a screen reader something to read`).not.toBe("");
    expect(reading).toMatch(/execution runs? in flight|No execution run is in flight/u);
    expect(reading).toMatch(/Peak \d+ this page/u);
    // The boundary rides with the reading wherever it is rendered, because a
    // number in the corner of a shell is exactly what gets read as CPU load.
    expect(reading).toContain("Browser-wide CPU load is not observable from a page");
  }
});

test("every disclosure on #capabilities is a 44px target on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "phone touch-target contract");
  await page.goto("/#capabilities");
  await expect(page.getByRole("heading", { name: "Capabilities" })).toBeVisible();
  // The runtime cards are rendered from an async probe; the disclosures under
  // test are theirs, so the sweep waits for the probe rather than racing it.
  await expect(page.locator(".capability-runtime").first()).toBeVisible();

  const summaries = page.locator(".capabilities-view summary");
  const count = await summaries.count();
  // A sweep that measures nothing passes vacuously. Every runtime card carries
  // one disclosure and the policy row carries the primitives list, so a report
  // with any runtime in it has at least two.
  expect(count).toBeGreaterThanOrEqual(2);
  // …and the route's own view is where all of them are, so scoping the sweep to
  // it does not quietly exclude a disclosure this page renders elsewhere.
  expect(await page.locator("main summary").count(), "no disclosure on this route escapes the sweep").toBe(count);
  for (let index = 0; index < count; index += 1) {
    const summary = summaries.nth(index);
    const box = await summary.boundingBox();
    const label = (await summary.textContent())?.trim() ?? `summary ${index}`;
    expect(box, `${label} is laid out`).not.toBeNull();
    expect(box!.height, `${label} reaches the 44px touch target`).toBeGreaterThanOrEqual(44);
    // Sized without changing the box type: `summary` is `display: list-item`,
    // and that is what paints the expand/collapse marker in Chromium and
    // WebKit. Reaching 44px by switching to flex takes the affordance away on
    // the exact surface the target exists for.
    await expect(summary).toHaveCSS("display", "list-item");
  }
});
