import { expect, test, type Locator, type Page } from "@playwright/test";



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
  await reset.click();
  const dialog = page.getByRole("dialog", { name: "Reset preferences?" });
  await expect(dialog).toBeVisible();
  // The consequence before the commitment, and the boundary of the change in
  // the same breath: the dialog has to say what it does NOT touch, or
  // "Conversations·profiles·vault" stays guesswork.
  //
  // Durability is named on the *excluded* side now. It used to be listed among
  // the things that return to their defaults, one sentence above the promise
  // that the vault is not touched — and both could not be true, because the
  // Durability row is the vault backend: resetting it starts a real provider
  // transition and detaches the adopted Vault. The reset keeps it instead of
  // the sentence keeping quiet about it.
  await expect(dialog).toContainText("Display and legacy approval preferences return to their defaults.");
  await expect(dialog).toContainText("Durability stays where you set it");
  await expect(dialog).toContainText("conversations, profiles, vault, and workspaces are not touched");
  await dialog.getByRole("button", { name: answer === "confirm" ? "Reset to defaults" : "Cancel" }).click();
}

test("Preferences reset preserves changes on Cancel and restores named defaults on Confirm", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark",
    typeScale: "default",
    density: "comfortable",
    corners: "subtle",
    bodyFont: "system-sans",
    // Deliberately NOT the default. The generic browser fixture advertises a
    // deployable Google client ID, so `google-drive` is what a whole-object
    // write of the defaults would put here — which is exactly the write that
    // used to detach the vault behind a dialog promising it would not. Starting
    // from the other side is what lets the assertion after Confirm fail if the
    // reset ever reaches the Durability row again.
    vaultBackend: "ephemeral",
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
  // …and the storage destination is still the one that was chosen, not the one
  // the defaults would have written. Reset restores display state; it does not
  // move where the work lives.
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("airship.display-preferences.v1") ?? "null") as { vaultBackend?: string } | null;
    return stored?.vaultBackend ?? "missing";
  })).toBe("ephemeral");
});
