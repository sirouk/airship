import { expect, test } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

/*
 * The reasoning the provider chose to expose must read like the rest of the
 * turn: a collapsible part beside tool calls, open one action away, with the
 * headline doing the glancing work. The Profile toggle that asks for it open
 * by default is display-only — same turn, same evidence, a deeper expansion.
 */
test("provider reasoning lands as its own collapsible part, summary first, full text one action away", async ({ page }) => {
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });
  // Reasoning is commentary under the Profile's density: at the house
  // default — minimal — it unmounts outright. This journey is about its
  // rendering, so it runs one rung up, where collapse vs. expand is the
  // Profile's reasoning preference instead of the density's.
  await setProfilePresentationDensity(page, "Balanced");
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.click();
  await composer.fill("/reason whether to ship on Friday");
  await page.getByRole("button", { name: "Send message" }).click();

  // Collapsed by default: the headline is visible, the body is not yet.
  const part = page.locator("details.reasoning-aside").first();
  await expect(part).toBeVisible({ timeout: 20_000 });
  await expect(part.locator("summary")).toContainText("Reasoning");
  await expect(part.locator(".reasoning-aside__meta")).toContainText("characters");
  await expect(part.locator(".reasoning-aside__body")).not.toBeVisible();

  // One deliberate action reveals exactly what the provider streamed.
  await part.locator("summary").click();
  const body = part.locator(".reasoning-aside__body");
  await expect(body).toBeVisible();
  await expect(body).toContainText('First I decide what "whether to ship on Friday" asks for.');
  await expect(body).toContainText("in the voice the profile set.");

  await page.goto("/#sessions", { waitUntil: "domcontentloaded" });
  const library = page.locator(".session-library-view");
  await expect(library).toBeVisible({ timeout: 15_000 });
  // The reasoning did not fork anything: exactly one thread owns the turn.
  await expect(
    library.getByRole("listitem").filter({ hasText: "/reason whether to ship on Friday" }),
  ).toHaveCount(1, { timeout: 15_000 });
});

test("the Profile display preference opens reasoning by default without touching the turn", async ({ page }) => {
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });
  // Same premise as the first journey: the reasoning preference perches on
  // top of the density rung, so both are exercised one above the default.
  await setProfilePresentationDensity(page, "Balanced");
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.click();
  await composer.fill("/reason the default expansion");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("details.reasoning-aside summary").first()).toBeVisible({ timeout: 20_000 });

  // The Profile preference lives with the profile's other boundaries, in the
  // editor the Profiles route opens on the selected profile.
  await page.goto("/#profiles", { waitUntil: "domcontentloaded" });
  const editor = page.locator(".profile-editor");
  await expect(editor.getByRole("textbox", { name: "Name" })).toBeVisible({ timeout: 15_000 });
  await editor.getByRole("button", { name: /Profile reasoning display/u }).click();
  await page.getByRole("option", { name: /Show by default/u }).click();
  await editor.getByRole("button", { name: "Save new revision" }).click();
  await expect(editor.getByText(/Revision saved/u)).toBeVisible({ timeout: 20_000 });

  // Same thread, next render: the reasoning starts open — display only changed.
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });
  const openBody = page.locator("details.reasoning-aside .reasoning-aside__body").first();
  await expect(openBody).toBeVisible({ timeout: 20_000 });
  await expect(openBody).toContainText('First I decide what "the default expansion" asks for.');
});
