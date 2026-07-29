import { expect, test, type Locator, type Page } from "@playwright/test";

const RESET_PROMPT = "Reset display, durability, and legacy approval preferences to their defaults?";

async function openPreferences(page: Page): Promise<Locator> {
  const desktopControl = page.getByRole("button", { name: "Open Preferences" });
  if (await desktopControl.isVisible()) {
    await desktopControl.click();
  } else {
    const mobile = page.getByRole("navigation", { name: "Mobile navigation" });
    await mobile.getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
  }
  const preferences = page.getByRole("dialog", { name: "Preferences" });
  await expect(preferences).toBeVisible();
  return preferences;
}

async function choose(preferences: Locator, label: string, option: string): Promise<void> {
  await preferences.getByRole("button", { name: label, exact: true }).click();
  await preferences.getByRole("listbox", { name: label }).getByRole("option", { name: option, exact: true }).click();
}

async function answerReset(page: Page, reset: Locator, answer: "cancel" | "confirm"): Promise<void> {
  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = reset.click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toBe(RESET_PROMPT);
  if (answer === "confirm") await dialog.accept();
  else await dialog.dismiss();
  await clickPromise;
}

test("Preferences reset preserves changes on Cancel and restores named defaults on Confirm", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark",
    typeScale: "default",
    density: "comfortable",
    corners: "subtle",
    bodyFont: "system-sans",
    // The generic browser fixture advertises a deployable Google client ID,
    // making this the named default and keeping Reset focused on display state.
    vaultBackend: "google-drive",
    approvalMode: "ask-first",
    transcriptOperations: "summary",
  })));
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toBeVisible();
  const preferences = await openPreferences(page);

  await preferences.getByRole("button", { name: "Color mode", exact: true }).click();
  const colorOptions = preferences.getByRole("listbox", { name: "Color mode" });
  const dark = colorOptions.getByRole("option", { name: "Dark instrument", exact: true });
  const paper = colorOptions.getByRole("option", { name: "Paper", exact: true });
  await expect(dark).toHaveAccessibleName("Dark instrument");
  await expect(paper).toHaveAccessibleName("Paper");
  await expect(dark.locator("svg[aria-hidden=true]")).toHaveCount(1);
  await expect(dark.locator("svg circle")).toHaveCount(0);
  await expect(paper.locator("svg[aria-hidden=true]")).toHaveCount(1);
  await expect(paper.locator("svg circle")).toHaveCount(1);
  await paper.click();
  await choose(preferences, "Density", "Compact");

  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(preferences.getByRole("button", { name: "Color mode", exact: true })).toContainText("Paper");
  await expect(preferences.getByRole("button", { name: "Density", exact: true })).toContainText("Compact");

  const reset = preferences.getByRole("button", { name: "Reset preferences", exact: true });
  await answerReset(page, reset, "cancel");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(preferences.getByRole("button", { name: "Color mode", exact: true })).toContainText("Paper");
  await expect(preferences.getByRole("button", { name: "Density", exact: true })).toContainText("Compact");

  await answerReset(page, reset, "confirm");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
  await expect(preferences.getByRole("button", { name: "Color mode", exact: true })).toContainText("Dark instrument");
  await expect(preferences.getByRole("button", { name: "Density", exact: true })).toContainText("Comfortable");
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("airship.display-preferences.v1") ?? "null") as { mode?: string; density?: string } | null;
    return stored ? `${stored.mode ?? ""}/${stored.density ?? ""}` : "missing";
  })).toBe("dark/comfortable");
});
