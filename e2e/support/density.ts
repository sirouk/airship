import { expect, type Page } from "@playwright/test";

/*
 * One way up the presentation-density ladder, through the same Profile editor
 * a person uses: the preference is a Profile revision, saved through the
 * Profiles route, never a test-only back door phoning the store.
 */
export async function setProfilePresentationDensity(
  page: Page,
  mode: "Minimal" | "Balanced" | "Instrumented",
): Promise<void> {
  await page.goto("/#profiles", { waitUntil: "domcontentloaded" });
  const editor = page.locator(".profile-editor");
  await expect(editor.getByRole("textbox", { name: "Name" })).toBeVisible({ timeout: 15_000 });
  await editor.getByRole("button", { name: /Profile presentation density/u }).click();
  await page.getByRole("option", { name: new RegExp(mode, "u") }).click();
  await editor.getByRole("button", { name: "Save new revision" }).click();
  await expect(editor.getByText(/Revision saved/u)).toBeVisible({ timeout: 20_000 });
}
