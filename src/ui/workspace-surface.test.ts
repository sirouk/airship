import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

/*
 * The stylesheet contracts for the workbench surface, written the way
 * `chat-layout.test.ts` writes them: assert on the rule that actually wins in
 * the cascade, and name the measured defect each rule was written against so a
 * future edit that deletes one has to argue with the measurement.
 */
const [styles, workspaceStyles, sourcesStyles, workspaceSource, sourcesSource] = await Promise.all([
  readAirshipStyles(),
  readFile(new URL("./workspace-view.css", import.meta.url), "utf8"),
  readFile(new URL("./sources-view.css", import.meta.url), "utf8"),
  readFile(new URL("./workspace-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
]);

describe("source control history row", () => {
  /*
   * Measured at tablet-768: the meta line is one text node —
   * `fe5341494b6c · 2026-08-08` — in a ~178px cell that the pair overruns by
   * about 5px, so the wrapper's `overflow: hidden` cut it mid-glyph under the
   * `↱` and the date printed "2026-08-0". A hash that has lost characters is
   * still that hash; a date that has lost a digit is a different date.
   */
  it("charges a narrow rail to the revision and never to the commit date", () => {
    const meta = workspaceStyles.match(/\.scm-history-row > button small \{([^}]+)\}/u)?.[1] ?? "";
    const oid = workspaceStyles.match(/\.scm-history-row__oid \{([^}]+)\}/u)?.[1] ?? "";
    const pinned = workspaceStyles.match(/\.scm-history-row__sep, \.scm-history-row__date \{([^}]+)\}/u)?.[1] ?? "";

    expect(meta).toContain("display: flex");
    // Without this the line cannot shrink below its own unbroken hash, which is
    // what left the overflow to be clipped instead of ellipsised.
    expect(meta).toContain("min-width: 0");
    expect(oid).toContain("min-width: 0");
    expect(pinned).toContain("flex: 0 0 auto");
  });

  it("keeps the whole committed timestamp in the markup the row abbreviates", () => {
    expect(workspaceSource).toContain('<time class="scm-history-row__date" dateTime={entry.committedAt}>');
    // The single text node that could only be cut, not truncated.
    expect(workspaceSource).not.toContain("<small>{short} · {entry.committedAt");
  });
});

describe("the phone runtime status band", () => {
  /*
   * `.runtime-line:not(.runtime-line--phone)` in shell.css carries this row's
   * centring and its gap, and cannot by construction reach the phone band.
   * Measured at 320x568: the 6px `.pulse-dot` has a height, so stretch parked
   * it against the band's top edge with its 3px halo across the topbar's
   * hairline, and with no gap the label started inside that halo.
   */
  it("centres the status dot in its band and keeps the label off it", () => {
    const band = [...styles.matchAll(/\.runtime-line--phone \{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "")
      .find((rule) => rule.includes("min-height: 34px")) ?? "";

    expect(band).toContain("align-items: center");
    expect(band).toMatch(/gap: \d+px/u);
    expect(band).toContain("min-height: 34px");
  });
});

describe("source posture chips", () => {
  /*
   * Measured at 320x568 in the workbench's advanced source controls: four chips
   * ask ~700px of a 263px row, the row hides its scrollbar, and the second chip
   * was cut mid-word with nothing saying a third and fourth existed.
   */
  it("marks the edge that is hiding a chip, and only while one is hidden", () => {
    const scroller = sourcesStyles.match(/\.git-posture-chips \{[^}]*overflow-x: auto[^}]*\}/u)?.[0] ?? "";

    expect(scroller).toContain("scrollbar-width: none");
    expect(sourcesStyles).toContain('.git-posture-chips[data-scroll-edges="start"] { mask-image: linear-gradient(to right, transparent 0, #000 24px); }');
    expect(sourcesStyles).toContain('.git-posture-chips[data-scroll-edges="end"] { mask-image: linear-gradient(to left, transparent 0, #000 24px); }');
    expect(sourcesStyles).toContain('.git-posture-chips[data-scroll-edges="both"] {');
    // An always-on fade would assert a hidden chip on a row that fits, so the
    // attribute the mask hangs on has to be the measured one.
    expect(sourcesSource).toContain('useScrollEdges(postureChipsRef, posture.length, "inline")');
    // Forced colours replace the palette a fade dissolves into.
    expect(sourcesStyles).toMatch(/@media \(forced-colors: active\) \{[\s\S]*\.git-posture-chips \{ mask-image: none; \}/u);
  });
});
