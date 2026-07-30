import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { completedTurnLabel, evidenceRecordLabel, overflowDestinationLabel } from "./mobile-navigation";
import { mobilePrimaryControlForView } from "./navigation-model";

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
    expect(trigger).toContain("aria-describedby={overflowDestination ? overflowHintId : undefined}");
    expect(source).toContain('const overflowDestination = activeControl === "more" ? overflowDestinationLabel(view) : undefined;');
    expect(source).toMatch(/<span id=\{overflowHintId\} class="sr-only">\{`Current page: \$\{overflowDestination\}`\}<\/span>/u);
    expect(source).not.toMatch(/<span>\{control\.label\}<\/span>\s*\{(?:currentDestination|overflowDestination)/u);
  });

  it("names every overflow destination, including the one with no sheet entry of its own", () => {
    // `context` is absent from MOBILE_MORE_ENTRIES, so a lookup that only read
    // that table would leave the #context route unnamed.
    const overflow = (["memory", "context", "profiles", "capabilities", "skills"] as const)
      .map((view) => [view, mobilePrimaryControlForView(view), overflowDestinationLabel(view)] as const);
    expect(overflow).toEqual([
      ["memory", "more", "Memory"],
      ["context", "more", "Memory"],
      ["profiles", "more", "Profiles"],
      ["capabilities", "more", "Capabilities"],
      ["skills", "more", "Skills"],
    ]);
  });

  it("removes the whole band from the accessibility tree while the sheet is open, so only one control is ever current", () => {
    expect(source).toContain('inert={moreOpen || chromeInert} aria-hidden={moreOpen || chromeInert || undefined}');
  });
});
