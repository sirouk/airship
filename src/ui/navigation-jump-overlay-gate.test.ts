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
  it("the hook accepts an enabled gate and refuses chords while it is closed", () => {
    expect(shellSource).toMatch(
      /useGlobalNavigationJumps\(navigate: \(view: NavigationView\) => void, enabled\?: \(\) => boolean\)/,
    );
    expect(shellSource).toContain("if (enabledRef.current && !enabledRef.current()) { clear(); return; }");
  });

  it("the shell passes the platform-overlay state as that gate", () => {
    expect(appSource).toContain(
      "const platformOverlayOpen = mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen || approvalPending || Boolean(profileCockpitTransition);",
    );
    expect(appSource).toContain("platformOverlayOpenRef.current = platformOverlayOpen;");
    expect(appSource).toMatch(/useGlobalNavigationJumps\(navigatePrimary,\s*\(\)\s*=>\s*!platformOverlayOpenRef\.current\)/);
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
