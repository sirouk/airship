import { expect, test } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

/*
 * Minimal is the house default: the person meets the quietest honest page,
 * and raising the rung re-renders the same thread in place — nothing
 * re-fetches, because the gate only ever decided which kept states mount.
 */
test("minimal first, then the whole thread re-renders when the rung rises", async ({ page }) => {
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".transcript");
  await page.waitForTimeout(900);
  await expect(page.locator("html")).toHaveAttribute("data-presentation-density", "minimal");

  // At minimal, an unsaved demo conversation keeps exactly its consequence answers:
  await expect(page.locator(".transcript-intro__unsaved")).toContainText("not being saved");
  await expect(page.locator(".transcript-intro__lead")).toContainText(/demo/u);
  await expect(page.locator(".transcript-intro__lead strong")).toHaveCount(0);
  await expect(page.locator(".transcript-intro__runtime")).toBeHidden();
  await expect(page.locator(".transcript-intro__tier")).toBeHidden();
  await expect(page.locator(".transcript-starters")).toBeHidden();

  // One turn, at minimal: work, voice, answer — no commentary, pills or proof chrome.
  await page.getByRole("combobox", { name: "Message Airship" }).fill("/reason whether suggestions stay quiet");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(5000);
  await expect(page.locator(".message.assistant .message-part.reasoning-summary")).toBeHidden();
  await expect(page.locator(".message-capability-tier")).toBeHidden();
  await expect(page.locator(".message-evidence-chips")).toBeHidden();
  await expect(page.locator(".message-part.part-footer")).toBeHidden();
  await expect(page.locator(".journal-chip__count")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-presentation-density", "minimal");

  // Raise the rung, and the same thread renders what was always recorded.
  await setProfilePresentationDensity(page, "Balanced");
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".transcript");
  await page.waitForTimeout(900);
  await expect(page.locator("html")).toHaveAttribute("data-presentation-density", "balanced");
  // *The* answer card — the last assistant turn — proves the same thread
  // re-rendered everything the gate retired; scoped so the profile-thanked
  // seeded welcome card specks every assertion an exact target.
  const answerCard = page.locator(".message.assistant").last();
  await expect(answerCard.locator(".message-part.reasoning-summary")).toHaveCount(1);
  await expect(answerCard.locator(".message-part.part-footer")).toHaveCount(1);
  await expect(answerCard.locator(".message-capability-tier")).toHaveCount(1);
  await expect(page.locator(".journal-chip__count")).toHaveCount(1);
  // The reasoning part stays collapsed — that is the Profile reasoning preference,
  // a rung the density never overrides.
  await expect(page.locator(".message-part.reasoning-summary pre.reasoning-summary__text")).toBeHidden();
});