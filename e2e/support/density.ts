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
  /* Keep the laboratory namespace alive: local-device vault lanes slice
   * plumbing through the query string, and dropping it would leave the spec
   * anywhere but the journal it is trapped in comparison against. */
  const namespaceQuery = new URL(page.url()).search;
  await page.goto(`/${namespaceQuery}#profiles`, { waitUntil: "domcontentloaded" });
  const editor = page.locator(".profile-editor");
  await expect(editor.getByRole("textbox", { name: "Name" })).toBeVisible({ timeout: 15_000 });
  const density = editor.getByRole("button", { name: /Profile presentation density/u });
  await density.click();
  await page.getByRole("option", { name: new RegExp(mode, "u") }).click();
  /*
   * The helper has to prove it moved the control before it saves through it.
   *
   * Without this the click was fire-and-forget: if the editor was still binding
   * its draft when the option was chosen, the selection landed on a draft that
   * was then replaced, "Save new revision" wrote the density the profile
   * already had, and every assertion downstream measured a rung nobody had
   * asked for. It surfaced as an order dependency rather than a failure —
   * `responsive-breakpoints`' zero-state geometry passed alone and failed when
   * `touch-target-floor` ran first, because a warm Vite graph changes which
   * side of that race the page lands on. A helper that cannot say the control
   * moved cannot be evidence for what the control controls.
   */
  await expect(density).toContainText(mode, { timeout: 15_000 });
  await editor.getByRole("button", { name: "Save new revision" }).click();
  await expect(editor.getByText(/Revision saved/u)).toBeVisible({ timeout: 20_000 });
  // And it survived the save, rather than the revision reverting it.
  await expect(density).toContainText(mode);
}
