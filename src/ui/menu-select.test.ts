import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MENU_SELECT_EDGE_GUTTER,
  MENU_SELECT_SHEET_TOLERANCE,
  menuSelectIsSheet,
  menuSelectShift,
  moveMenuSelection,
} from "./menu-select";

describe("menu selection keyboard movement", () => {
  const options = [{ disabled: false }, { disabled: true }, { disabled: false }];

  it("wraps with arrow keys and skips disabled options", () => {
    expect(moveMenuSelection(0, "ArrowDown", options)).toBe(2);
    expect(moveMenuSelection(2, "ArrowDown", options)).toBe(0);
    expect(moveMenuSelection(0, "ArrowUp", options)).toBe(2);
  });

  it("moves to enabled boundaries with Home and End", () => {
    expect(moveMenuSelection(2, "Home", options)).toBe(0);
    expect(moveMenuSelection(0, "End", options)).toBe(2);
  });
});

describe("the trigger states a selection only when there is one", () => {
  /*
   * `value` can name no option — empty before a choice is made, stale after a
   * catalog refresh, or simply not yet present in a list still being fetched.
   * Clamping that miss to index 0 made the trigger render the first option as
   * chosen, so a model picker asserted a model the session had never pinned.
   * Opening still starts at the top; only the claim about state changed.
   */
  const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");

  it("keeps the display index separate from the navigation index", () => {
    expect(source).toMatch(/const matchedIndex = options\.findIndex\(\(option\) => option\.value === value\);/u);
    // Where to open still has an answer when nothing matches.
    expect(source).toMatch(/const selectedIndex = Math\.max\(0, matchedIndex\);/u);
    // What to display does not invent one.
    expect(source).toMatch(/const selected = matchedIndex < 0 \? undefined : options\[matchedIndex\];/u);
  });

  it("leaves the no-selection fallback reachable", () => {
    // `?? "Choose"` was written for exactly this case and could never fire
    // while the index was clamped.
    expect(source.match(/selected\?\.label \?\? "Choose"/gu)?.length).toBe(2);
  });
});

describe("keys the listbox handles stay inside the listbox", () => {
  /*
   * The option buttons live inside whatever surface owns the `MenuSelect` —
   * in `PreferencesDialog`, an Escape that only closed the listbox still
   * bubbled into the dialog's own keydown and closed the dialog too.
   * Handled keys stop propagating; Tab does not, because focus leaving the
   * listbox is exactly what Tab is for.
   */
  it("stops propagation of Escape and the other handled option keys, never of Tab", () => {
    const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");
    expect(source).toMatch(
      /event\.key === "Escape"\)\s*\{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/u,
    );
    // Every fully-handled branch carries the guard…
    expect(source.match(/event\.stopPropagation\(\)/gu)?.length).toBeGreaterThanOrEqual(3);
    // …and there is no path where Tab joins them.
    expect(source).not.toMatch(/key === "Tab"\)\s*\{\s*event\.(preventDefault|stopPropagation)/u);
  });
});

describe("an anchored listbox ends up on the screen, whichever way it opens", () => {
  it("puts a left-overflowing panel back inside the gutter", () => {
    /*
     * The measured defect, at the width it was measured on. The composer's
     * approval-policy chooser is 400px wide and pinned by `right: 0` to a
     * trigger whose own right edge is at 363 on a 768px tablet, so the panel
     * rendered at x=-36.9 and all three option labels — the words `Ask First`,
     * `Auto Approve`, `Full Access` — started off the left edge of the screen.
     */
    expect(menuSelectShift({ panelLeft: -36.9, panelRight: 363.1, viewportWidth: 768 }))
      .toBe(MENU_SELECT_EDGE_GUTTER + 37);
  });

  it("pulls a right-overflowing panel back the other way", () => {
    expect(menuSelectShift({ panelLeft: 500, panelRight: 900, viewportWidth: 768 }))
      .toBe(-(900 - (768 - MENU_SELECT_EDGE_GUTTER)));
  });

  it("leaves a panel that already clears both gutters exactly where it is", () => {
    expect(menuSelectShift({ panelLeft: MENU_SELECT_EDGE_GUTTER, panelRight: 760, viewportWidth: 768 })).toBe(0);
    expect(menuSelectShift({ panelLeft: 200, panelRight: 600, viewportWidth: 768 })).toBe(0);
  });

  it("shows the left edge when the panel cannot fit between both gutters", () => {
    // A listbox wider than the screen can only show one of its edges, and its
    // labels are left-aligned: the right edge is the one with no words on it.
    const shifted = menuSelectShift({ panelLeft: -50, panelRight: 800, viewportWidth: 768 });
    expect(-50 + shifted).toBe(MENU_SELECT_EDGE_GUTTER);
  });

  it("skips the horizontal pass for the sheet and measures the sheet instead", () => {
    const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");
    const effect = source.slice(source.indexOf("useLayoutEffect(() => {\n    if (!open"));
    // The two branches are exclusive: a panel pinned to both viewport edges has
    // nothing to shift, and an anchored one has no sheet contract to earn.
    const compact = effect.slice(effect.indexOf("} else {"), effect.indexOf('if (placement !== "down") return;'));
    expect(compact).toContain("menuSelectIsSheet");
    expect(compact).toContain("setSheet(");
  });

  it("runs the horizontal pass for both placements and measures a clean panel", () => {
    const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");
    const effect = source.slice(source.indexOf("useLayoutEffect(() => {\n    if (!open"));
    // The upward placement is the one the defect was on; gating the whole pass
    // on `down` is what let it through.
    const guard = effect.slice(0, effect.indexOf("\n", effect.indexOf("if (!open")));
    expect(guard).not.toContain('placement !== "down"');
    // The pass that keeps it on the screen runs before the branch that returns
    // for anything but `down`, which is the ordering the defect turned on.
    expect(effect.indexOf("menuSelectShift")).toBeLessThan(effect.indexOf('if (placement !== "down") return;'));
    // A flip or a shift left on the node from a previous open is measured as if
    // the stylesheet had put it there, so both are cleared before reading.
    const horizontal = effect.slice(effect.indexOf("if (!narrowViewport)"), effect.indexOf("if (placement !== \"down\") return;"));
    expect(horizontal.indexOf('listbox.style.transform = "";'))
      .toBeLessThan(horizontal.indexOf("getBoundingClientRect()"));
    expect(horizontal).toContain('listbox.style.left = "";');
    expect(horizontal).toContain('listbox.style.right = "";');
    // And the sheet tier is pinned to both viewport edges by CSS, so it is not
    // measured at all.
    expect(effect.indexOf("narrowViewport")).toBeLessThan(effect.indexOf("menuSelectShift"));
  });
});

describe("the compact shell's sheet is recognised from the box the stylesheet gave it", () => {
  /*
   * `popover.tsx` decides its own mode from the viewport, because nothing but
   * `popover.css` positions a popover. `MenuSelect` cannot: the composer's
   * approval chooser is handed to `.composer` and anchored above the input
   * (`routes.css:3884`) and the session switcher is pinned under the session bar
   * (`routes.css:3498`), both from stylesheets this component never sees, and
   * both would be ruined by a header, a scrim and a 64px landscape inset.
   *
   * So the question is asked of the rendered box, and these are the two
   * populations it has to separate — every number measured on the shipped build.
   */
  const phone = { viewportWidth: 430, viewportHeight: 932 };
  const landscape = { viewportWidth: 932, viewportHeight: 430 };

  it("calls the shared narrow rule's panel a sheet at both compact tiers", () => {
    // Preferences, profiles, vault, skills, sessions: x=8, right vw-8, bottom vh-8.
    expect(menuSelectIsSheet({ panelLeft: 8, panelRight: 422, panelBottom: 924, ...phone })).toBe(true);
    expect(menuSelectIsSheet({ panelLeft: 8, panelRight: 924, panelBottom: 422, ...landscape })).toBe(true);
  });

  it("leaves the panels a route stylesheet places itself alone", () => {
    // The composer's approval policy, anchored above the input: 400px wide at
    // x=20, ending 161px short of the bottom edge. It reads whole, it hits, and
    // `e2e/composer-layout.spec.ts` measures all of that.
    expect(menuSelectIsSheet({ panelLeft: 20, panelRight: 420, panelBottom: 771, ...phone })).toBe(false);
    // The session switcher: full width, but hung under the bar at the top.
    expect(menuSelectIsSheet({ panelLeft: 8, panelRight: 422, panelBottom: 269.3, ...phone })).toBe(false);
    // The topbar profile menu: `top: 58px`, 320px wide, neither edge nor bottom.
    expect(menuSelectIsSheet({ panelLeft: 8, panelRight: 328, panelBottom: 220, ...phone })).toBe(false);
    // An anchored desktop listbox is not a sheet however tall the panel is.
    expect(menuSelectIsSheet({ panelLeft: 640, panelRight: 980, panelBottom: 900, viewportWidth: 1_440, viewportHeight: 900 }))
      .toBe(false);
  });

  it("separates the two populations by the same gutter the sheet rule uses", () => {
    expect(MENU_SELECT_SHEET_TOLERANCE).toBeGreaterThanOrEqual(MENU_SELECT_EDGE_GUTTER);
    // The nearest opt-out clears the bottom edge by 161px and the nearest sheet
    // sits 8px inside it, so the threshold is nowhere near either population.
    const edge = { panelLeft: 8, panelRight: 422, ...phone };
    expect(menuSelectIsSheet({ ...edge, panelBottom: 932 - MENU_SELECT_SHEET_TOLERANCE })).toBe(true);
    expect(menuSelectIsSheet({ ...edge, panelBottom: 932 - MENU_SELECT_SHEET_TOLERANCE - 1 })).toBe(false);
  });
});

describe("a sheet says whose it is, and can be left", () => {
  const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./menu-select.css", import.meta.url), "utf8");

  /*
   * The defect, in one sentence: at 430x932 the Preferences `Color mode` listbox
   * opened 221.6px from its own trigger with `Corners` — a different setting —
   * as the nearest label above it, and in 14 recorded opens the panel covered
   * the control it belonged to. A panel pinned across the bottom of a phone has
   * stopped pointing at anything; the header is what puts the name back.
   */
  it("gives the sheet a header carrying the trigger's own accessible name", () => {
    expect(source).toContain('<div class="menu-select-sheet-header">');
    expect(source).toMatch(/\{sheet \? \(\s*<div class="menu-select-sheet-header">\s*<strong>\{ariaLabel\}<\/strong>/u);
    // The same string the trigger publishes, so the two cannot drift.
    expect(source).toContain("aria-label={ariaLabel}");
  });

  it("keeps the listbox owning options and nothing else", () => {
    // A heading and a Done button inside `role="listbox"` are two nodes an
    // assistive technology has no slot for, so the panel is the box and the
    // list is the role — the arrangement `popover.tsx` already uses.
    expect(source).toContain('<div id={listboxId} class="menu-select-list" role="listbox" aria-label={ariaLabel}>');
    expect(source).toContain('<div ref={popover} class="menu-select-popover">');
    // `aria-controls` still names the node that carries the role.
    expect(source).toContain("aria-controls={open ? listboxId : undefined}");
  });

  it("hangs the scrim on the host and asks the two pressable boxes about dismissal", () => {
    // Hit-testing a pseudo-element reports its originating element, so
    // `root.contains(target)` answered "inside the menu" for a press on the dim
    // and left the sheet standing over the route with no way out.
    const dismissal = source.slice(source.indexOf("const handleOutsidePointer"), source.indexOf("const handleEscape"));
    expect(dismissal).toContain("trigger.current?.contains(target)");
    expect(dismissal).toContain("popover.current?.contains(target)");
    expect(dismissal).not.toContain("root.current?.contains(event.target");
    expect(styles).toContain('.menu-select[data-sheet="true"]::before { content:""; position:fixed; z-index:319;');
    expect(styles).toContain("background:var(--scrim);");
    // One under the panel, so whatever stacking context the pair resolves
    // against, the panel is the one on top.
    expect(styles).toContain("z-index:320;");
  });

  /*
   * The listbox renders with `aria-expanded="true"` in the same commit that
   * schedules its dismissal listeners, so a passive effect left one frame in
   * which an open menu answered neither Escape nor an outside click — and the
   * repository's own anchored-menu gate failed 27 times in 50 runs on it.
   */
  it("installs dismissal before the frame the listbox is open in", () => {
    const install = source.slice(0, source.indexOf("const handleOutsidePointer"));
    expect(install.slice(install.lastIndexOf("Effect(() => {") - 20)).toContain("useLayoutEffect(() => {");
  });

  it("lets Escape reach an open menu from anywhere without taking the key from anyone else", () => {
    const escape = source.slice(source.indexOf("const handleEscape"), source.indexOf('document.addEventListener("pointerdown"'));
    // Any open menu, anchored or sheet: a pointer click leaves focus on the
    // trigger, and from there Escape used to reach nothing at all.
    expect(escape).toContain('if (event.key !== "Escape") return;');
    expect(escape).not.toContain("!sheet");
    // A keypress from an option still belongs to the option handler, which is
    // the branch that stops propagation and restores focus. The trigger is not
    // an option, so it is handled here.
    expect(escape).toContain("root.current?.contains(document.activeElement) && document.activeElement !== trigger.current");
    expect(escape).not.toContain("stopPropagation");
    expect(escape).toContain("close(false)");
  });

  it("measures each open against the stylesheet's own answer", () => {
    // A panel already wearing the sheet contract sits 64px above the bottom edge
    // on the short shape — the one answer that would make the measurement say
    // no. So the flag is false on the way in, by both routes into an open.
    const openAt = source.slice(source.indexOf("const openAt ="), source.indexOf("useEffect(() => {"));
    expect(openAt).toContain("setSheet(false);");
    const close = source.slice(source.indexOf("const close ="), source.indexOf("const openAt ="));
    expect(close).toContain("setSheet(false);");
    // And the dim cannot outlive the panel it explains.
    expect(source).toContain('data-sheet={open && sheet ? "true" : undefined}');
  });
});

describe("the sheet's own geometry, and the two numbers it borrows", () => {
  const styles = readFileSync(new URL("./menu-select.css", import.meta.url), "utf8");

  it("is flush with the bottom edge on an upright phone", () => {
    expect(styles).toContain('.menu-select[data-sheet="true"] .menu-select-popover { inset:auto 0 0 0;');
    expect(styles).toContain("border-radius:var(--radius-panel) var(--radius-panel) 0 0;");
    // The flush sheet ends at the screen's edge, so it pays for the home indicator.
    expect(styles).toContain("padding-bottom:calc(var(--sp-4) + env(safe-area-inset-bottom));");
  });

  /*
   * Measured at 932x430 on the shipped build: every menu sheet was a 916px strip
   * running to y=422 across a navigation band at y=386..430, so 19 of the
   * landscape opens covered the one control that answers "can I go somewhere
   * else". The repair is not invented here — it is `.mobile-sheet-scrim`'s own
   * reservation in `routes.css`, which `popover.css` also took, and it lands the
   * panel at y=115..366 with the band untouched below it.
   */
  it("becomes a centred card clear of the navigation band on the short shape", () => {
    const landscape = styles.slice(styles.indexOf('@media (max-width:950px) and (max-height:500px) {\n  .menu-select[data-sheet'));
    expect(landscape).toContain("bottom:calc(64px + env(safe-area-inset-bottom));");
    expect(landscape).toContain("width:min(100% - (2 * var(--sp-3)),640px);");
    expect(landscape).toContain("max-height:min(72dvh,680px);");
    expect(landscape).toContain("margin-inline:auto;");
    // A scrim that covered the band would take back exactly the reachability
    // the panel gave up height to preserve.
    expect(landscape).toContain('.menu-select[data-sheet="true"]::before { bottom:calc(64px + env(safe-area-inset-bottom)); }');
  });

  it("keeps Done a 44px target with a 28px mark inside it, whatever the route says about buttons", () => {
    // `.session-library-toolbar button` is (0,2,0) and gives every button in
    // that toolbar `min-height: 42px`, a border and a fill — measured at 42px on
    // the sessions filter sheets before this rule was scoped through the host.
    expect(styles).toContain('.menu-select[data-sheet="true"] .menu-select-done { position:relative; flex:none; min-width:64px; min-height:44px;');
    expect(styles).toContain("border:0;");
    // The pill retreats inside the target rather than the target shrinking, so
    // the button's border stops sharing an edge with the sheet's own frame.
    expect(styles).toContain('.menu-select[data-sheet="true"] .menu-select-done::before { content:""; position:absolute; inset:var(--sp-2) 0;');
  });

  it("does not let a declared min-width replace the label's own floor", () => {
    // `min-width: <length>` on a flex item REPLACES `min-width: auto` and so
    // removes the min-content floor — that is how the popover's `Done` came to
    // ride its own border at three phone widths. `flex: none` is the repair that
    // outlives any number the Type scale or a translation produces.
    const rule = styles.slice(styles.indexOf('.menu-select[data-sheet="true"] .menu-select-done {'));
    const declarations = rule.slice(0, rule.indexOf("}"));
    expect(declarations.indexOf("flex:none")).toBeLessThan(declarations.indexOf("min-width:64px"));
  });

  it("shows the header in the sheet tier and nowhere else", () => {
    expect(styles).toContain(".menu-select-sheet-header { display:none; }");
    expect(styles).toContain('.menu-select[data-sheet="true"] .menu-select-sheet-header { display:flex; position:sticky; top:0;');
    // The title is the only statement of which control the sheet belongs to, so
    // it wraps rather than ellipsising: half of `Profile minimum proof posture`
    // names nothing.
    expect(styles).toContain("overflow-wrap:anywhere;");
  });
});
