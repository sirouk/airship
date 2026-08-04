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
   * Verdigris declares `colorScheme: "dark"`. The theme layer has
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

/*
 * The same rule from the side that did not exist until the library had light
 * palettes at all, and the side that would be far worse if it broke.
 *
 * A dark manifest wrongly pinned under Paper produced dark surfaces under light
 * dividers — bad, but the ink was still pale on a dark bed. A *light* manifest
 * wrongly pinned under Dark instrument would write near-white surfaces while
 * the dark sheet keeps its pale `--ink`, `--line` and every verdict hex: white
 * on white, and the verdict vocabulary is exactly what stops being readable.
 * `deferToStylesheet` is symmetric and already covers this, which is the point
 * — the assertion is here so it stays symmetric.
 *
 * Measured on the running page rather than reasoned about: the shipped dark
 * ink reads 6.14:1 against the surface behind it while Rosé Pine Dawn is the
 * selected theme, because the palette layer wrote nothing.
 */
test("previewing a light-scheme theme on Dark instrument keeps the dark instrument", async ({ page }) => {
  await openThemeLibrary(page, "dark");

  await themeOption(page, "Rosé Pine Dawn").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rose-pine-dawn");
  expect(await inlineSurface(page)).toBe("");
  await expect(page.getByText("Previewing — not saved")).toBeVisible();
  expect(await readPresentation(page), "light preview under Dark instrument").toEqual({ ...PINNED });

  // The ink the dark sheet still owns, against the bed it is actually painted
  // on. A pinned light palette would collapse this toward 1:1.
  const inkOnSurface = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const channels = (value: string): [number, number, number] => {
      const hex = value.trim().replace("#", "");
      const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
      return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
    };
    const luminance = (rgb: readonly number[]): number => {
      const [red, green, blue] = rgb.map((channel) => {
        const scaled = channel / 255;
        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
    };
    const [high, low] = [
      luminance(channels(style.getPropertyValue("--ink"))),
      luminance(channels(style.getPropertyValue("--surface"))),
    ].sort((left, right) => right - left);
    return (high! + 0.05) / (low! + 0.05);
  });
  expect(inkOnSurface).toBeGreaterThan(7);
});
