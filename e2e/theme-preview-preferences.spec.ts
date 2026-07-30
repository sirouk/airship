import { expect, test, type Page } from "@playwright/test";

/**
 * Previewing a theme may not silently rewrite the user's display preferences.
 *
 * Preview was implemented by calling `applyTheme` directly, and `applyTheme` is
 * a whole-instrument commit: it writes the same five `<html>` attributes the
 * preference layer owns (mode, type scale, density, corners, body font). The
 * one effect that reasserts preferences is keyed on `[activeTheme, preferences]`
 * and a preview changes neither, so a user on Paper at Extra large who clicked
 * a theme swatch was moved to dark and compact and left there — while the
 * Preferences dialog kept reporting the settings it no longer had.
 *
 * Two further defects the reviewer found are asserted here too, because both
 * are only visible from the browser: the undo effect was keyed on the preview
 * id, so choosing a *second* theme reverted the surface to the saved one while
 * the button still read "Previewing"; and the undo restored the *selected*
 * profile's theme rather than the active profile's.
 *
 * Deliberately non-default values for all four presentation preferences. A
 * preference left at its default resolves to whatever the theme establishes —
 * that is the seam that makes `ThemeManifest.typography`/`.layout` live at all
 * — so a default-valued preference legitimately moves under a preview and
 * would make this assertion vacuous. These four are pinned overrides, and
 * every one of them disagrees with at least one previewed theme's manifest.
 */
const PINNED = Object.freeze({
  mode: "dark",
  typeScale: "x-large",
  density: "compact",
  corners: "rounded",
  bodyFont: "system-serif",
});

type Presentation = Readonly<Record<string, string | undefined>>;

async function readPresentation(page: Page): Promise<Presentation> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      mode: root.dataset.mode,
      typeScale: root.dataset.typeScale,
      density: root.dataset.density,
      corners: root.dataset.corners,
      bodyFont: root.dataset.bodyFont,
    };
  });
}

/** The inline palette layer, which is what a preview is actually for. */
async function inlineSurface(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue("--surface").trim());
}

function themeOption(page: Page, name: string) {
  return page.locator(`.theme-options button:has(strong:text-is("${name}"))`);
}

async function openThemeLibrary(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      ...preferences,
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  }, { ...PINNED, mode });
  await page.goto("/#profiles");
  await expect(page.getByRole("heading", { name: "Profiles", level: 1 })).toBeVisible();
  // The Interface theme disclosure opens by default: the library was the one
  // section nobody could preview without a click, which is exactly backward.
  await expect(page.locator(".theme-options")).toBeVisible();
}

test("previewing a theme leaves every display preference exactly where the user set it", async ({ page }) => {
  await openThemeLibrary(page, "dark");
  const before = await readPresentation(page);
  expect(before).toEqual({ ...PINNED });
  // Foundry's palette *is* the dark stylesheet, so the shipped default profile
  // writes no inline property at all. That is the baseline a preview departs
  // from and the state Cancel must return to.
  expect(await inlineSurface(page)).toBe("");

  /*
   * Anchored on the option's own `<strong>`, not its accessible name: name
   * matching is a case-insensitive substring, and Foundry's description reads
   * "restrained brass and verdigris signals", so `name: "Verdigris"` selects
   * two of the three options.
   */
  await themeOption(page, "Verdigris").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "verdigris");
  expect(await inlineSurface(page)).toBe("#131a15");
  expect(await readPresentation(page), "first preview").toEqual({ ...PINNED });

  /*
   * The second click is the one the reviewer caught. The undo effect used to
   * list `previewThemeId` in its dependency array, so choosing another theme
   * ran the teardown with the stale id and repainted the *saved* theme a frame
   * after the new one was applied — while "Previewing — not saved" and the
   * pressed state both still described the new theme.
   */
  await themeOption(page, "Blue Ledger").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "blue-ledger");
  expect(await inlineSurface(page)).toBe("#151c25");
  expect(await readPresentation(page), "second preview").toEqual({ ...PINNED });
  await expect(page.getByText("Previewing — not saved")).toBeVisible();

  await page.getByRole("button", { name: "Cancel preview" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "foundry");
  expect(await inlineSurface(page)).toBe("");
  expect(await readPresentation(page), "cancelled preview").toEqual({ ...PINNED });
});

test("previewing a dark-scheme theme on Paper keeps the light instrument", async ({ page }) => {
  await openThemeLibrary(page, "light");
  expect(await readPresentation(page)).toEqual({ ...PINNED, mode: "light" });

  /*
   * All three shipped themes declare `colorScheme: "dark"`. The theme layer has
   * no light expression of a dark palette, so when the mode in force disagrees
   * with the manifest the only truthful answer is to write nothing and let the
   * light stylesheet own the instrument — otherwise nine dark roles get pinned
   * inline over light dividers and inks, which is what made Paper unreadable on
   * the Research and Developer profiles. Asserted on the inline layer, because
   * inline is precisely what outranked the light sheet.
   */
  await themeOption(page, "Verdigris").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "verdigris");
  expect(await inlineSurface(page)).toBe("");
  expect(await readPresentation(page), "preview under Paper").toEqual({ ...PINNED, mode: "light" });
});
