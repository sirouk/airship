import { expect, test } from "@playwright/test";

/**
 * The one place where a dropped ARIA name was a lost fact, checked as a render.
 *
 * Each cell of the Chutes eligibility matrix is a glyph — `✓` or `—` — with the
 * word only ever present as an `aria-label` on the wrapping `<span>`. ARIA
 * forbids naming an element whose computed role is `generic`, so that label was
 * discarded and every cell announced a bare glyph. `src/ui/aria-name-contract`
 * stops the class from returning in source; this asserts the consequence the
 * source test cannot see, because "what name does the browser compute" is a
 * question only a browser answers. There is no DOM test environment in this
 * repo (no jsdom, no testing-library), so the render harness is this one.
 */
test("every eligibility mark announces a word, never its glyph", async ({ page }) => {
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press("Escape");

  // The matrix lives behind a `<details>`; its summary is the disclosure.
  await page.locator("summary", { hasText: "Compare what each method can do" }).click();
  const matrix = page.locator(".capability-table-wrap");
  await expect(matrix).toBeVisible();

  // Four capability rows, three columns of marks: sign-in eligible, key
  // eligible, and what the active method actually grants.
  const marks = matrix.getByRole("img");
  await expect(marks).toHaveCount(12);
  // Sign-in and key are eligible for all four capabilities; with no connection
  // held, the active-method column grants none of them.
  await expect(matrix.getByRole("img", { name: "Available", exact: true })).toHaveCount(8);
  await expect(matrix.getByRole("img", { name: "Unavailable", exact: true })).toHaveCount(4);

  // The glyph is decoration and must not be reachable as a name.
  await expect(matrix.getByRole("img", { name: "✓" })).toHaveCount(0);
  await expect(matrix.getByRole("img", { name: "—" })).toHaveCount(0);

  // Each mark's name is its own, not inherited from the row: the row header
  // still carries the capability word beside it.
  await expect(matrix.getByRole("rowheader", { name: /Identity/u })).toBeVisible();
});
