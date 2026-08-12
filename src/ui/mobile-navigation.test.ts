import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  completedTurnLabel,
  currentDestinationLabel,
  destinationHintForControl,
  evidenceRecordLabel,
} from "./mobile-navigation";
import { MOBILE_MORE_ENTRIES, MOBILE_PRIMARY_CONTROLS, mobilePrimaryControlForView, type NavigationView } from "./navigation-model";

const source = readFileSync(new URL("./mobile-navigation.tsx", import.meta.url), "utf8");

describe("mobile navigation badges", () => {
  it("labels completed work as completed and routes evidence to Trust", () => {
    expect(completedTurnLabel(1)).toBe("1 completed turn");
    expect(completedTurnLabel(5)).toBe("5 completed turns");
    expect(evidenceRecordLabel(1)).toBe("1 evidence record");
    expect(evidenceRecordLabel(5)).toBe("5 evidence records");
    expect(source).not.toContain("pendingLabel(");
    expect(source).not.toContain('control.id === "more"\n              ? attestationNoticeCount');
  });

  it("uses a neutral Proof-presence dot when no evidence record count exists", () => {
    expect(source).toContain("proofPresence");
    expect(source).toContain("mobile-nav__badge--presence");
    expect(source).toContain("Proof available");
  });
});

describe("every route states its location to assistive tech, including the five in the overflow", () => {
  /*
   * Five of fourteen views (memory, context, profiles, capabilities, skills)
   * map to the More control and to nothing else, so the trigger is the only
   * band control that can carry their location. Stripping `aria-current` from
   * it — to prevent a double claim with the sheet entry — left those five
   * routes announcing no current page at all while `.is-current` still
   * highlighted the tab. The double claim it was protecting against is
   * unreachable: the sheet entry asserts current only while the sheet is open,
   * and the `<nav>` is `inert` + `aria-hidden` exactly then.
   */
  it("puts aria-current on all three route-bearing controls and on nothing else", () => {
    const occurrences = source.match(/aria-current=/gu) ?? [];
    // The primary route tab, the overflow trigger, and the sheet entry.
    expect(occurrences).toHaveLength(3);
    // Whichever control is current carries the hint; the two claims are gated
    // on the same `current`, so a tab cannot say "current page" without saying
    // which page when its own label is not the route's name.
    expect(source.match(/aria-describedby=\{current && currentDestination \? destinationHintId : undefined\}/gu) ?? [])
      .toHaveLength(2);
    expect(source).toMatch(/onClick=\{\(\) => onNavigate\(control\.view\)\}/u);
    expect(source).toMatch(/aria-current=\{current \? "page" : undefined\}\s*onClick=\{\(\) => navigateFromMore/u);
  });

  it("keeps the overflow trigger's location claim and names which destination it stands for", () => {
    const start = source.indexOf('control.kind === "overlay"');
    const trigger = source.slice(start, source.indexOf("onClick={() => moreOpen", start));
    expect(trigger).toContain("ref={moreButton}");
    // The claim itself, gated on the same `current` the highlight uses, so the
    // eye and the screen reader cannot disagree.
    expect(trigger).toContain('aria-current={current ? "page" : undefined}');
    expect(trigger).toContain("navClass(current, open)");
    // "More, current page" does not say which page; the description does. It is
    // a description and not extra name text on purpose: the control is still
    // named exactly "More", which is how every caller and journey addresses it.
    expect(trigger).toContain("aria-describedby={current && currentDestination ? destinationHintId : undefined}");
    expect(source).toContain("const currentDestination = destinationHintForControl(activeControl, view);");
    expect(source).toMatch(/<span id=\{destinationHintId\} class="sr-only">\{`Current page: \$\{currentDestination\}`\}<\/span>/u);
    expect(source).not.toMatch(/<span>\{control\.label\}<\/span>\s*\{currentDestination/u);
    // The gate that produced "Trust, current page" on three routes.
    expect(source).not.toContain('activeControl === "more" ?');
  });

  it("names every destination, including the one with no sheet entry of its own", () => {
    // `context` is absent from MOBILE_MORE_ENTRIES, so a lookup that only read
    // that table would leave the #context route unnamed. It is named through
    // the canonical fallback instead, and asserted beside four views that do
    // have sheet rows so a regression in either branch reddens this.
    const named = (["memory", "context", "profiles", "capabilities", "skills"] as const)
      .map((view) => [view, mobilePrimaryControlForView(view), currentDestinationLabel(view)] as const);
    expect(named).toEqual([
      // Memory owns a band control now, so its own tab is what highlights —
      // and #context, which has no control of its own, highlights Memory's.
      ["memory", "memory", "Memory"],
      ["context", "memory", "Memory"],
      ["profiles", "more", "Profiles"],
      ["capabilities", "more", "Capabilities"],
      ["skills", "more", "Skills"],
    ]);
    expect(MOBILE_MORE_ENTRIES.some((entry) => entry.id === "context")).toBe(false);
  });

  it("names the route on every control whose own label is not the route's name", () => {
    /*
     * Vault, Account and Connection were outside both the fix and its
     * regression net: on #vault the phone announced "Trust, current page" — a
     * name no route carries — and tapping the highlighted tab left for Proof.
     * Desktop states the truth on those same routes (rail.tsx puts
     * `aria-current="page"` on a row labelled "Vault"), so the phone was the
     * surface that lied. The description fixed the announcement; the highlight
     * itself has since moved to More, which is where all three routes live and
     * the only tab a person can follow back to them. Both halves are read here.
     */
    const hinted = (["vault", "billing", "access", "sessions", "editor", "terminal"] as const)
      .map((view) => [view, mobilePrimaryControlForView(view), destinationHintForControl(mobilePrimaryControlForView(view), view)] as const);
    expect(hinted).toEqual([
      ["vault", "more", "Vault"],
      ["billing", "more", "Account"],
      ["access", "more", "Connection"],
      ["sessions", "chat", "All conversations"],
      ["editor", "workspace", "Editor"],
      ["terminal", "workspace", "Terminal"],
    ]);
  });

  it("stays silent only where the control's label already is the route", () => {
    // A hint on #chat under a tab named "Chat" would be a second name for one
    // place, which is the noise this description exists to avoid.
    for (const control of MOBILE_PRIMARY_CONTROLS) {
      if (control.kind !== "route") continue;
      expect(destinationHintForControl(control.id, control.view)).toBeUndefined();
    }
    // …and never silent anywhere else: every view either names itself through
    // its control or gets a description.
    const views: readonly NavigationView[] = [
      "chat", "sessions", "workspace", "editor", "terminal", "memory", "context",
      "profiles", "capabilities", "skills", "vault", "billing", "proof", "access",
    ];
    for (const view of views) {
      const controlId = mobilePrimaryControlForView(view);
      const control = MOBILE_PRIMARY_CONTROLS.find((candidate) => candidate.id === controlId);
      const named = control?.kind === "route" && control.view === view;
      expect(named || Boolean(destinationHintForControl(controlId, view)), `${view} states where it is`).toBe(true);
    }
  });

  it("removes the whole band from the accessibility tree while the sheet is open, so only one control is ever current", () => {
    expect(source).toContain('inert={moreOpen || chromeInert} aria-hidden={moreOpen || chromeInert || undefined}');
  });
});
