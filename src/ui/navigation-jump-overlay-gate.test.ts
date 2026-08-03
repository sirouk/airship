import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The `g`-prefix navigation chords registered by `useGlobalNavigationJumps`
 * are a window-level keydown listener. With a modal platform overlay open
 * (command palette, preferences, trust sheet, mobile "more" sheet, approval
 * prompt, profile transition), the routed surface is inert — but inert only
 * suppresses pointer and focus interaction, not window key handling — so a
 * chord fired `navigatePrimary` underneath the dialog, swapping the route and
 * pushing history invisibly where the route-focus effect then no-ops on an
 * inert target. These assertions pin the overlay gate.
 */
const [appSource, shellSource] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./platform-shell.tsx", import.meta.url), "utf8"),
]);

describe("navigation-jump overlay gate", () => {
  /*
   * Asserted as a contract, not as a source literal.
   *
   * Both halves used to pin the exact signature and the exact expression, so a
   * correct addition failed here: the hook grew a `switchProfile` argument for
   * the `g 1`…`g 9` profile chords, and the overlay set grew `shortcutsOpen`
   * when the shortcut sheet arrived. A test that fails when a new overlay is
   * correctly gated is teaching the opposite of what it exists to teach.
   */
  it("the hook accepts an enabled gate and refuses chords while it is closed", () => {
    const signature = /useGlobalNavigationJumps\(\s*navigate: \(view: NavigationView\) => void,\s*enabled\?: \(\) => boolean/u;
    expect(shellSource).toMatch(signature);
    expect(shellSource).toContain("if (enabledRef.current && !enabledRef.current()) { clear(); return; }");
  });

  it("the shell passes the platform-overlay state as that gate", () => {
    const declaration = /const platformOverlayOpen = ([^;]+);/u.exec(appSource)?.[1] ?? "";
    expect(declaration, "platformOverlayOpen is not declared").not.toBe("");
    // Every surface that takes the keyboard has to be in the gate. Adding an
    // overlay without adding it here is exactly the regression this catches.
    for (const overlay of [
      "mobileMoreOpen", "paletteOpen", "preferencesOpen", "trustSheetOpen",
      "approvalPending", "profileCockpitTransition", "shortcutsOpen",
    ]) {
      expect(declaration, `${overlay} does not gate the navigation chords`).toContain(overlay);
    }
    expect(appSource).toContain("platformOverlayOpenRef.current = platformOverlayOpen;");
    expect(appSource).toMatch(/useGlobalNavigationJumps\(\s*navigatePrimary,\s*\(\)\s*=>\s*!platformOverlayOpenRef\.current/u);
  });

  it("rail and overlay-owned navigation stay ungated on navigatePrimary itself", () => {
    // The gate must NOT be baked into navigatePrimary: rail buttons and
    // overlay-owned navigation (palette entries, trust-sheet rows) call it
    // directly and must keep working while an overlay is open.
    expect(appSource).toContain('function navigatePrimary(next: View) {\n    if (next === "proof") {');
    expect(appSource).toContain("onNavigate={navigatePrimary}");
    expect(appSource).toContain("navigate: navigatePrimary");
  });
});
