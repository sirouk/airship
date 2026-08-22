import { expect, test } from "@playwright/test";

/**
 * What a person can see and do about ambient recall.
 *
 * The claim the panel makes is checkable from the page: it lists the excerpts
 * with the same provenance sentence the agent is handed, states the per-turn
 * budget in the numbers the turn lane actually enforces, and its switch empties
 * the document it describes. The harness mounts the real route over a real
 * MemoryWorkspace, so the last assertion reads the bytes the switch wrote.
 */
test.describe("the Memory route's ambient recall panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      document.body.replaceChildren(Object.assign(document.createElement("main"), { id: "ambient-recall-root" }));
      const { mountAmbientRecallHarness } = await import("/e2e/fixtures/ambient-recall-harness.tsx");
      await mountAmbientRecallHarness(document.querySelector("#ambient-recall-root")!);
    });
  });

  test("lists what is indexed with its provenance and states the per-turn budget", async ({ page }) => {
    const panel = page.locator("#memory-ambient-recall");
    await expect(panel).toBeVisible();
    await panel.evaluate((element: HTMLDetailsElement) => { element.open = true; });
    await expect(panel).toContainText("may add at most 2 excerpts, 1024 bytes in total");
    await expect(panel).toContainText("inside the context budget the turn already had");
    await expect(panel).toContainText("I like unicorn milk and I want it to be blue");
    await expect(panel).toContainText('You said, in "Drinks" (turn 2, 2026-08-01)');
    await expect(panel).toContainText('The agent said, in "Drinks" (turn 5, 2026-08-01)');
    await expect(panel.getByRole("status")).toContainText("2 excerpts from 1 conversation in this profile");
  });

  test("the switch empties the index and says so, and is reachable from the keyboard", async ({ page }, testInfo) => {
    const panel = page.locator("#memory-ambient-recall");
    await panel.evaluate((element: HTMLDetailsElement) => { element.open = true; });
    const toggle = panel.getByRole("button", { name: "Turn ambient recall off" });
    await expect(toggle).toBeVisible();
    if (testInfo.project.name === "mobile-chromium") {
      const box = (await toggle.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(panel.getByRole("status")).toContainText("Ambient recall is off. The excerpts were deleted");
    await expect(panel.getByRole("button", { name: "Turn ambient recall on" })).toBeVisible();
    await expect(panel).not.toContainText("I like unicorn milk and I want it to be blue");
    const stored = await page.evaluate(() => globalThis.airshipRecallDocument());
    expect(JSON.parse(stored!)).toMatchObject({ version: 1, enabled: false, cursors: {}, excerpts: [] });
  });
});
