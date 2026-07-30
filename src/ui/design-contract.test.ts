import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const [appSource, attestationSource, sealSource, sessionsSource, sourcesSource, styles, vaultStyles, localLabStyles, menuStyles, mobileNavSource, routeStyles, durabilityStyles] = await Promise.all([
  // The shell is two files since the rail was extracted: the compact topbar
  // picker still lives in `app.tsx`, the pinned rail picker in `rail.tsx`.
  // The contract is about the *pair* existing, so it reads the pair.
  Promise.all([
    readFile(new URL("./app.tsx", import.meta.url), "utf8"),
    readFile(new URL("./rail.tsx", import.meta.url), "utf8"),
  ]).then((sources) => sources.join("\n")),
  readFile(new URL("./attestations-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./seal.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sessions-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
  readAirshipStyles(),
  readFile(new URL("./vault-view.css", import.meta.url), "utf8"),
  readFile(new URL("./local-lab-setup.css", import.meta.url), "utf8"),
  readFile(new URL("./menu-select.css", import.meta.url), "utf8"),
  readFile(new URL("./mobile-navigation.tsx", import.meta.url), "utf8"),
  Promise.all([
    readFile(new URL("./access-view.css", import.meta.url), "utf8"),
    readFile(new URL("./attestations-view.css", import.meta.url), "utf8"),
    readFile(new URL("./context-view.css", import.meta.url), "utf8"),
    readFile(new URL("./sources-view.css", import.meta.url), "utf8"),
  ]).then((sources) => sources.join("\n")),
  // Outside the barrel: `main.tsx` imports it directly, so the contract tests
  // have to read it by name or the retired 50% dot could quietly come back.
  readFile(new URL("./durability-indicator.css", import.meta.url), "utf8"),
]);

describe("Airship Instrument design contract", () => {
  it("uses the shared Seal instead of retired proof glyphs", () => {
    expect(appSource).not.toMatch(/seal-glyph|large-seal|[◐⌛]/u);
    expect(attestationSource).not.toMatch(/statusSymbol|[◐⌛]/u);
    expect(appSource).toContain("<Seal");
    expect(attestationSource).toContain("<Seal");
  });

  it("exposes one accessible image and keeps the SVG presentational", () => {
    expect(sealSource).toContain('role="img"');
    expect(sealSource).toContain("aria-label={accessibleLabel}");
    expect(sealSource).toContain('aria-hidden="true"');
    expect(sealSource).toContain('<span class="seal__label">{label}</span>');
  });

  it("gives every seal density a well of at least 16px and a word in the accessible name", () => {
    // P2 forbids a seal glyph below 16px. `dot` is the density that hides its
    // label, so if any density were allowed to shrink it would be this one —
    // and a sub-16px mark with no word leaves colour as the only carrier.
    expect(sealSource).toMatch(/sealRenderedSize\(size \?\? \(density === "hero" \? 28 : 16\)\)/u);
    expect(sealSource).toMatch(/sealDensitySize\(density,\s*size\)/u);
    expect(sealSource).toContain("Math.max(16, size)");
    // The clipped label is a layout instruction, never `display: none`: the
    // verdict word has to survive into the accessible tree.
    expect(styles).toMatch(/\.seal\[data-density="dot"\]\s+\.seal__label\s*\{[^}]*clip-path/u);
    expect(styles).not.toMatch(/\.seal\[data-density="dot"\]\s+\.seal__label\s*\{[^}]*display:\s*none/u);
  });

  it("draws one chip recipe rather than a border treatment per status family", () => {
    const chip = styles.match(/\.seal\[data-density="chip"\]\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(chip).toContain("border-radius: var(--radius-chip)");
    expect(chip).toContain("color-mix(in srgb, currentColor 34%, transparent)");
    // The retirement ledger: one grouped rule, not one rule per family. Each
    // entry still draws its own chip because its call site lives in a file
    // another package owns; they share this recipe verbatim, so the list may
    // shrink but no entry may reacquire a border, radius or type size.
    const ledger = styles.match(/\.status-seal,\n(?:\.[a-z-]+,\n)*\.runtime-posture \{([^}]+)\}/u);
    expect(ledger?.[0]).toContain(".receipt-chip,\n.attestation-chip,\n.audit-state,\n");
    expect(ledger?.[1]).toContain("border-radius: var(--radius-chip)");
    expect(ledger?.[1]).toContain("color-mix(in srgb, currentColor 34%, transparent)");
    // `.proof-level` left the ledger by losing its call site, not by being
    // restyled: the Proof route's claim-stack heading drew a verdict-shaped
    // pill ~40px under the route's hero verdict, so the declaration it carried
    // moved into the receipt record as a labelled "Declared proof level" field.
    expect(styles).not.toContain(".proof-level");
    // The literal radii these families used to carry: 999px, 5px hard-coded,
    // 4px, and an 8px dot at 50%.
    expect(durabilityStyles).not.toMatch(/border-radius:\s*50%/u);
    expect(styles).not.toMatch(/\.(?:status-seal|audit-state|runtime-posture)\s*\{[^}]*border-radius:\s*999px/u);
    // `.state-label` rendered nowhere: it was a 49th family with no call site,
    // so it is deleted rather than migrated.
    expect(styles).not.toContain(".state-label");
  });

  it("keeps a copper or failed verdict word above the caption contrast floor", () => {
    // Both tones measure 4.24:1 on a raised surface. They stay legal as seal
    // strokes, where 1.4.11's 3:1 applies; the word does not inherit them.
    expect(styles).toMatch(
      /\.seal\[data-density="chip"\]\[data-state="asserted"\] \.seal__label,\n\.seal\[data-density="chip"\]\[data-state="failed"\] \.seal__label \{\s*color: var\(--ink\);/u,
    );
  });

  it("keeps notice tone off the sentence it tints", () => {
    // A notice is a sentence, not a verdict word: the state colours the
    // boundary and the fill, and the words keep an ink that clears AA.
    const notice = styles.match(/\.workbench-notice\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(notice).toContain("--notice-tone");
    expect(notice).toContain("color: var(--ink-muted)");
  });

  it("locks the canonical truth palette independently of profile accents", () => {
    expect(property("--v-verified")).toBe("#67a39a");
    expect(property("--v-caution")).toBe("#d9a441");
    // Raised from #c86758 (4.53:1 on --surface, 4.24:1 on --surface-raised) and
    // stepped again from #ce7769 when the curated palettes arrived: the house
    // rule has always been that the lightest shipped raised surface decides
    // this hex, and One Dark's #282d36 is that bed now. Sixteen rules paint
    // words with it, so it is held to 1.4.3's 4.5:1 on both beds in every
    // theme by `css-variable-contract.test.ts`.
    expect(property("--v-failed")).toBe("#d68172");
    expect(property("--v-info")).toBe("#7fa8c9");
    expect(property("--truth-local")).toBe("#8ba0a6");
    expect(property("--truth-remote")).toBe("#bd6f4c");
  });

  it("uses copper only as the asserted working metal and keeps a responsive profile switcher pair", () => {
    // Raised from #b8734f for the same reason — the asserted seal's label and
    // both asserted chips are words, not glyphs — and stepped from #be805f
    // against the same lightest raised surface as --v-failed above.
    expect(property("--copper")).toBe("#c78a66");
    expect(styles).toContain('.seal[data-state="asserted"]');
    expect(styles).toMatch(/\.seal\[data-state="asserted"\]\s*\{[^}]*color:\s*var\(--copper\)/u);
    expect(styles).not.toContain("--copper: var(--accent)");
    expect(appSource.match(/ariaLabel="Agent profile"/gu)).toHaveLength(2);
    expect(menuStyles).toContain(".compact-profile-menu { display:none; }");
    expect(appSource).not.toMatch(/<select[^>]+aria-label="Agent profile"/u);
  });

  it("uses one styled menu contract instead of native route selects", () => {
    expect(`${appSource}\n${sessionsSource}\n${sourcesSource}`).not.toMatch(/<select(?:\s|>)/u);
    expect(menuStyles).toContain(".menu-select.placement-down .menu-select-popover");
  });

  it("uses one focus token, immutable verdict tones, and the display face across rem views", () => {
    expect(property("--focus")).toBe("var(--accent-bright)");
    expect(`${vaultStyles}\n${localLabStyles}`).not.toMatch(/--signal-(?:good|warn|info)|#8db8df|var\(--focus,/u);
    expect(vaultStyles).toContain("var(--v-verified)");
    expect(localLabStyles).toContain("var(--v-caution)");
    // The serif has exactly one job — `.route-title`, owned by <RouteHeader> —
    // so a route sheet that re-declares the display face is re-forking the
    // heading rule it was meant to retire. `access-view.css` and
    // `sources-view.css` have handed theirs back; the two that remain are
    // counted here so a third cannot reappear unnoticed.
    expect(routeStyles.match(/font-family:\s*var\(--font-display\)/gu)).toHaveLength(2);
  });

  it("renders the mobile shell as four fixed primary controls without horizontal scrolling", () => {
    const mobileNavRules = [...styles.matchAll(/\.mobile-nav\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const mobileRule = mobileNavRules.find((rule) => rule.includes("repeat(4")) ?? "";
    /*
     * AMENDED — the track list may carry one leading `auto` column, and only
     * that. It holds the shell's live-load reading, which is a `role="status"`
     * region rather than a fifth destination: below this breakpoint `.sidebar`
     * is `display: none`, so the rail's copy leaves the render tree and the
     * accessibility tree, and a phone reader was left navigating to
     * #capabilities to learn what was running.
     *
     * The claim this test makes is unchanged and is now stated as a suffix
     * rather than as the whole value: four primary controls, equal shares of
     * whatever width remains, no scroll, no auto flow. A fifth *destination*
     * still fails it, because `repeat(4, …)` is still the tail of the list.
     */
    expect(mobileRule).toMatch(/grid-template-columns:\s*(?:auto )?repeat\(4, minmax\(0, 1fr\)\);/u);
    expect(mobileNavSource).toContain("<RuntimeLoadIndicator placement=\"nav\" />");
    // Nothing else may claim the track: the reading is the one non-destination
    // child, so the tabs cannot be pushed off the row by a second occupant.
    expect(mobileNavSource.match(/<RuntimeLoadIndicator/gu)).toHaveLength(1);
    expect(mobileRule).toContain("overflow: hidden");
    expect(mobileRule).not.toContain("overflow-x: auto");
    expect(mobileRule).not.toContain("grid-auto-flow");
  });
});

function property(name: string): string | undefined {
  const marker = name + ":";
  const start = styles.indexOf(marker);
  if (start < 0) return undefined;
  return styles.slice(start + marker.length).split(";", 1)[0]?.trim();
}
