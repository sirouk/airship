import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { conversationAxesNote } from "./topbar";
import type { TrustAxis } from "./platform-shell";
import { readAirshipStyles } from "./style-sheets.test-helper";

function axis(over: Partial<TrustAxis> & Pick<TrustAxis, "id" | "state">): TrustAxis {
  return Object.freeze({
    scope: "conversation",
    label: "Fixture claim",
    detail: "Fixture sentence.",
    view: "proof",
    ...over,
  }) as TrustAxis;
}

describe("conversationAxesNote", () => {
  it("stays silent on a healthy conversation, because the count already accounts for it", () => {
    const note = conversationAxesNote([axis({ id: "e2ee", state: "none" }), axis({ id: "attestation", state: "asserted" })]);

    expect(note?.text).toBeUndefined();
    // Silent visually, never silent to a screen reader: the deferral is a fact
    // about where to look and it is spoken with its count.
    expect(note?.spoken).toContain("2 of them are scoped to this conversation");
    expect(note?.spoken).toContain("session bar");
  });

  it("escalates a failed conversation claim into the topbar, because some routes have no session bar", () => {
    const note = conversationAxesNote([
      axis({ id: "e2ee", state: "asserted" }),
      axis({ id: "attestation", state: "failed" }),
    ]);

    expect(note?.state).toBe("failed");
    expect(note?.text).toBe("1 of 2 in this conversation failed");
    // A pointer, never a second verdict: the claim's own words stay in the band
    // that owns them, so the topbar cannot drift from the session bar's copy.
    expect(note?.text).not.toContain("Fixture claim");
  });

  it("ranks a failure above an attention, and never merges the two counts", () => {
    const note = conversationAxesNote([
      axis({ id: "e2ee", state: "attention" }),
      axis({ id: "attestation", state: "failed" }),
    ]);

    expect(note?.state).toBe("failed");
    expect(note?.text).toBe("1 of 2 in this conversation failed");
  });

  it("reports attention on its own when nothing failed", () => {
    const note = conversationAxesNote([axis({ id: "attestation", state: "attention" })]);

    expect(note?.state).toBe("attention");
    expect(note?.text).toBe("1 of 1 in this conversation needs attention");
    expect(note?.sealLabel).toBe("Attention");
  });

  it("returns nothing when no claim is deferred at all", () => {
    expect(conversationAxesNote([])).toBeUndefined();
  });
});

const [topbar, app, styles] = await Promise.all([
  readFile(new URL("./topbar.tsx", import.meta.url), "utf8"),
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readAirshipStyles(),
]);

/*
 * The scope rule, pinned where it can regress.
 *
 * One turn used to print "Evidence unavailable" in the topbar and "Evidence
 * unavailable · this session" in the session bar 40px below. The topbar's copy
 * was the same claim with the scope word removed — which is how a fact ends up
 * asserted more broadly than the code establishes it.
 */
describe("the topbar speaks for the browser tab", () => {
  it("draws its resting verdict from tab-scoped axes only", () => {
    expect(topbar).toContain('trustAxesInScope(axes, "tab")');
    expect(topbar).toContain('trustAxesInScope(axes, "conversation")');
    expect(topbar).toContain("worstTrustAxis(tabAxes.length > 0 ? tabAxes : axes)");
  });

  it("still counts every axis it stands in front of, including the deferred two", () => {
    // The chip's count is its statement of its own cost and it may not shrink
    // to match the narrower set the verdict is drawn from; `airship-shell.spec`
    // asserts the sheet renders exactly as many rows as the chip claims.
    expect(topbar).toContain("{axes.length} runtime claims");
  });

  it("keeps every axis in the sheet, grouped rather than dropped", () => {
    expect(app).toContain('scope: "tab"');
    expect(app).toContain('scope: "conversation"');
    // Four axes in, four axes out. The devil's advocate pass rejected replacing
    // the four-axis posture with a rollup count, and this is where that holds.
    expect(app.match(/scope: "tab"/gu)?.length).toBe(2);
    expect(app.match(/scope: "conversation"/gu)?.length).toBe(2);
  });

  it("steps the claim behind its seal where a phone has run out of room for words", () => {
    /*
     * Measured at 320: a state ring, the character `B`, an ellipsis — and the
     * count already clipped out below to pay for it. That is
     * `Browser / Edge runtime` spent down to one letter, which is precisely the
     * defect the comment above the `<Seal>` says the band collapse exists to
     * remove. A legible glyph beats a legible fragment, so past that width the
     * label leaves the layout rather than being chewed by it.
     *
     * 360, not the 400 this first pinned. 400 was borrowed from the tier the
     * session bar's chips yield at, and it was measured against the wrong
     * screen: at 390 the chip reads `Browser / Ed…`, truncated and still naming
     * the runtime, so clipping there gave up a legible label to fix an
     * illegible one two sizes down. Thirteen route audits compared before and
     * after and reported that loss independently. One width for "no room for
     * words" is right; it is simply not the session bar's width, because these
     * labels are not the same length.
     *
     * Re-derived, not re-borrowed, after the chip's width moved under it: in
     * this block the label's box is the viewport less 307px, `Browser` sets
     * 48px of ink, and a word survives only while the box holds that ink plus
     * 5px — so 360 is the exact viewport at which the first word stops fitting.
     */
    const yielded = styles.slice(styles.indexOf(".topbar-posture-chip .seal__label"));
    expect(yielded).toMatch(/\.topbar-posture-chip \.seal__label \{[^}]*clip-path: inset\(50%\)/u);
    // Under a width, never unconditionally: between 360 and 640 there is still
    // room for a word, and the ellipsis rule above is the one that should win.
    expect(yielded.slice(0, yielded.indexOf("clip-path"))).toContain("@media (max-width: 360px)");
    // Clipped out of the layout, never removed. The whole sentence is still the
    // control's accessible name, and the sheet still renders every claim.
    expect(topbar).toContain("Runtime trust for this browser tab. Weakest claim:");
  });

  it("leaves the tier's measurement basis alone: nothing is added to the track the chip is measured against", () => {
    /*
     * The tier above is a width, so it is worth exactly as much as the chip's
     * width is stable — and the chip's width is what survives the brand track.
     * `.topbar` shares `--rail-width` with `.app-shell` so the mark keeps
     * tracking the rail, which means a rail that widens itself for its own
     * reasons narrows this chip, silently, on every route at once.
     *
     * That is not hypothetical. Half a touch target reserved at the rail's seam
     * to hold a collapse grip took 13px off this chip at every touch width, and
     * 390 went from `Browser / Ed…` to `Browser / E…` — a word cut after one
     * letter — under a tier written on the first of those two renderings.
     *
     * Pinned here as well as beside the rail, because the rail is the last
     * place anyone auditing the topbar would think to look for the cost.
     */
    const declared = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(declared).toContain("grid-template-columns: var(--rail-width) minmax(280px, 1fr) minmax(0, auto);");

    const widths = [...declared.matchAll(/--rail-width:\s*([^;]+);/gu)].map(([, value]) => value!.trim());
    expect(widths.length).toBeGreaterThan(3);
    // A sum is the shape this arrives in: some length, plus room for something
    // that is not the rail's contents. There is no such thing to make room for
    // — a grip that hangs off the seam is paid for in overhang, in shell.css.
    for (const width of widths) expect(width).not.toContain("+");
  });
});
