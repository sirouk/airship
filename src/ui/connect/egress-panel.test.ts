import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./egress-panel.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./egress-panel.css", import.meta.url), "utf8");
/** Declarations only: a rule quoted in a comment is prose, not a rule. */
const declarations = styles.replace(/\/\*[\s\S]*?\*\//gu, "");

describe("the panel reports observation and nothing else", () => {
  it("reads the live ledger rather than a list of hosts it expects", () => {
    // A surface that compares against an expected set can only ever miss the
    // host nobody thought of — which is precisely the defect that produced it.
    expect(source).toContain("recorder.subscribe(read)");
    expect(source).toContain("installEgressRecorder() ?? egressRecorder()");
    expect(source).not.toMatch(/chutes\.ai/u);
  });

  it("prints which witness saw each row, because they know different things", () => {
    expect(source).toContain("Recorded as Airship sent it");
    expect(source).toContain("Observed in the browser's resource timeline; method and credential not disclosed");
  });

  it("prints an em dash for a method the browser never disclosed", () => {
    expect(source).toContain('{record.method ?? "—"}');
  });

  it("never prints a byte count the browser declined to give", () => {
    expect(source).toContain('record.bytes === undefined ? " · size not disclosed"');
  });

  it("withdraws its completeness sentence when the timeline stops keeping entries", () => {
    expect(source).toContain("recorder.timelineTruncated()");
    expect(source).toContain("The browser's resource timeline filled up");
  });
});

describe("the verdict survives a phone", () => {
  it("keeps the credential clause out of a chip that ellipsises by design", () => {
    /*
     * Measured at 390×844: `.seal__label` is 306px of box holding 453px of
     * text, under `white-space: nowrap; text-overflow: ellipsis` from
     * shell.css. The half that got clipped was the credential clause — the
     * claim the panel exists to make.
     */
    expect(source).toContain("label={egressCountLabel(remote)}");
    expect(source).toContain('<p class={`egress-panel__verdict ${credentialTone(totals)}`}>');
  });

  it("lets nothing inside push a track wider than the card", () => {
    // main.scrollWidth measured 514 against a 390 client width once the request
    // list had rows, clipping the lede and the verdict.
    expect(declarations).toMatch(/\.egress-panel > \*,[\s\S]*?min-width: 0;/u);
  });

  it("stacks the host row on a phone instead of dropping a column", () => {
    expect(declarations).toMatch(/@media \(max-width: 720px\) \{\s*\.egress-panel__hosts > li \{\s*grid-template-columns: minmax\(0, 1fr\);/u);
  });

  it("gives the three credential verdicts three different tones", () => {
    for (const [tone, token] of [["is-clean", "--v-verified"], ["is-undisclosed", "--v-neutral"], ["is-attached", "--v-caution"]] as const) {
      const rule = declarations.slice(declarations.indexOf(`.egress-panel__verdict.${tone}`));
      expect(rule.slice(0, rule.indexOf("}")), tone).toContain(token);
    }
  });
});
