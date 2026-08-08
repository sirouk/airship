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
     * remove. A legible glyph beats a legible fragment, so past 400px the label
     * leaves the layout rather than being chewed by it.
     */
    const yielded = styles.slice(styles.indexOf(".topbar-posture-chip .seal__label"));
    expect(yielded).toMatch(/\.topbar-posture-chip \.seal__label \{[^}]*clip-path: inset\(50%\)/u);
    // Under a width, never unconditionally: between 400 and 640 there is still
    // room for a word, and the ellipsis rule above is the one that should win.
    expect(yielded.slice(0, yielded.indexOf("clip-path"))).toContain("@media (max-width: 400px)");
    // Clipped out of the layout, never removed. The whole sentence is still the
    // control's accessible name, and the sheet still renders every claim.
    expect(topbar).toContain("Runtime trust for this browser tab. Weakest claim:");
  });
});
