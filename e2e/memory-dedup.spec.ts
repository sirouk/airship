import { expect, test } from "@playwright/test";

/**
 * Phase-1 dedup, end to end: two near-identical manual pins surface ONE
 * duplicate cluster in the Memory tab, and the merge folds them into the
 * representative through the same approval dock every other write uses.
 * The dock is the lane this feature ships in — the spec takes it rather
 * than a full-access shortcut, and sees the consent copy travel with the
 * tool definition.
 */
test("manual duplicate review merges two near-identical records", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#memory");
  await page.getByRole("heading", { level: 1, name: "Memory" }).waitFor();
  const records = page.locator("#memory-records");
  await records.waitFor();
  if (!(await records.evaluate((el: HTMLDetailsElement) => el.open))) await records.locator("summary").click();

  // Asserted, not probed: `count()` does not auto-wait, so a dock that has not
  // rendered yet reads zero and a tolerant helper walks past it. The failure
  // that hides behind that tolerance is the one worth catching — a memory write
  // that stops asking — so the dock has to be here, under the name it derives
  // from the live `update_memory` definition.
  const allowOnce = async () => {
    const dock = page.getByRole("dialog", { name: /Allow update_memory once/u });
    await expect(dock).toBeVisible({ timeout: 20000 });
    await dock.getByRole("button", { name: "Allow once" }).click();
  };

  const remember = async (content: string) => {
    await page.locator("#memory-remember-content").fill(content);
    await page.getByRole("button", { name: "Remember", exact: true }).click();
    await allowOnce();
    await expect(page.locator("#memory-remember-content")).toHaveValue("", { timeout: 20000 });
  };

  await remember("The turbine pressure limit is 42 bar.");
  await remember("The turbine pressure limit is 42 bar at the inlet manifold.");

  const review = page.getByText("1 group of near-identical records");
  await expect(review).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("The turbine pressure limit is 42 bar at the inlet manifold.").first()).toBeVisible();
  const cluster = page.locator(".memory-duplicates__cluster").first();
  await expect(cluster).toContainText("keep");
  await expect(cluster).toContainText("fold in");

  await cluster.getByRole("button", { name: "Merge into one record" }).click();
  await allowOnce();
  await expect(page.getByText(/Forgot memory/u).first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("region", { name: "Possible duplicates" })).toHaveCount(0);
});
