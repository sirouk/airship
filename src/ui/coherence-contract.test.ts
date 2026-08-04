import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("progressive disclosure coherence contract", () => {
  it("does not render the account dashboard before a readable account exists", async () => {
    const source = await readFile(new URL("./billing-view.tsx", import.meta.url), "utf8");
    // AMENDED: the gate no longer names which credential methods exist — that
    // is Connection's fact, and a build without the sign-in exchange made the
    // old sentence a promise Account had no input to keep. The page-memory
    // contract, which Account does own, is still pinned verbatim.
    expect(source).toContain("Connect a Chutes credential to read account telemetry. The credential remains held only in page memory.");
    expect(source).toContain("{accountReadable ? <>{snapshot?.issues.length");
    expect(source.indexOf("billing-gate-preview")).toBeLessThan(source.indexOf("{accountReadable ? <>"));
  });

  // Replaces "puts the source task before mobile posture detail", which pinned
  // an ordering *between two renderings of the same facts*: a desktop-only
  // three-card grid and a phone-only disclosure. Ordering them correctly was
  // never the invariant worth having — rendering them once was. This is the
  // stronger form: exactly one posture element, at every width, and the trust
  // facts computed in exactly one place, so the 660-character transport
  // paragraph cannot be printed twice on one screen again.
  it("states the source posture exactly once, at every width", async () => {
    const source = await readFile(new URL("./sources-view.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("./sources-view.css", import.meta.url), "utf8");
    expect(source.match(/class="git-sources-trust-disclosure"/gu)).toHaveLength(1);
    expect(source.match(/<SourceTrustFacts /gu)).toHaveLength(1);
    expect(source).not.toContain("git-sources-trust-desktop");
    expect(source.match(/capabilities\.remote\.detail/gu)).toHaveLength(1);
    expect(styles).not.toMatch(/\.git-sources-trust-disclosure\s*\{[^}]*display:\s*none/u);
  });

  it("advertises the bounded trust navigation contract", async () => {
    const source = await readFile(new URL("./platform-shell.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("./platform-shell.css", import.meta.url), "utf8");
    expect(source).toContain('aria-label="Trust hub, four horizontally scrollable views; the conversation\'s own evidence first, then the global services"');
    /*
     * The strip states the scope it used to drop. `Trust` is a filing group,
     * not a scope: Proof is `session` — the receipts of the conversation you
     * are in — and Vault, Connection and Account are `global`. Rendered as flat
     * peers, the strip told a reader that this conversation's evidence is a
     * global settings page, and it disagreed with both the rail (whose `GLOBAL`
     * band sits above Vault) and `profile-silo`'s `data-scope="global"` ledger,
     * which names those three and deliberately not Proof.
     */
    expect(source).toContain('<span class="trust-hub-tabs__band" data-scope={tab.scope}>{TRUST_TAB_GLOBAL_BAND}</span>');
    // One band, in one place: the index is resolved from the table, so a
    // destination that changes scope moves the seam instead of stranding it.
    expect(source).toContain("const TRUST_TAB_BAND_INDEX = TRUST_TABS.findIndex((tab) => tab.scope === \"global\");");
    expect(source).toContain('data-scope={tab.scope} title={`${tab.label} · ${tab.scope} scope`}');
    expect(styles).toContain(".trust-hub-tabs__band");
    expect(styles).toContain("scroll-snap-type: x proximity");
    expect(styles).toContain("overscroll-behavior-inline: contain");
    expect(styles).toContain(".trust-hub-tabs button { min-height: 44px");
  });

  /*
   * The last four places one turn was described in more than one language.
   *
   * Each of these is a string a reader meets, so each is asserted against the
   * source that renders it rather than against a helper. They are source scans
   * because the defect is always a *second* spelling appearing beside the
   * canonical one, and only the file can prove the second spelling is gone.
   */
  it("speaks one vocabulary for a connection boundary, a profile field and an authority class", async () => {
    const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    const attestations = await readFile(new URL("./attestations-view.tsx", import.meta.url), "utf8");

    // One boundary label, defined once, in the file that renders the model
    // card. "E2EE · evidence recorded" read as a verdict about the turn when
    // the fact it stated was that this connection has no proof gate.
    expect(app).not.toContain('return "E2EE');
    expect(app).not.toContain("function activeConnectionBoundaryLabel");
    expect(app).toContain('import { activeConnectionProofLabel, ModelControl } from "./model-control";');
    expect(app.match(/activeConnectionProofLabel\(connection\)/gu)).toHaveLength(1);
    expect(app.match(/e2eeBoundaryLabel/gu)).toHaveLength(4);

    // One name for the profile field the catalog card, the select and the
    // revision strip all show within 400px of each other.
    expect(app).not.toContain("Minimum posture");
    // Both chips now read the field's name from one exported constant rather
    // than repeating the string. Counting literals was the weaker form of this
    // assertion: two identical literals satisfy it and can still be edited
    // apart, whereas two references to the same constant cannot drift at all.
    expect(app.match(/prefix=\{PROFILE_POSTURE_FIELD_LABEL\}/gu)).toHaveLength(2);
    expect(app).not.toContain('prefix="Minimum proof"');

    // "Established" is retired as a state word: it meant *recorded* on the
    // claim rail and *unproven* in the metric 183px away.
    expect(attestations).toContain('return "No verification authority";');
    expect(attestations).not.toContain("established");
  });

  it("states one ceiling sentence, in one direction, on every surface that states it", async () => {
    const facts = await readFile(new URL("./claim-stack-facts.ts", import.meta.url), "utf8");
    const model = await readFile(new URL("./attestations-model.ts", import.meta.url), "utf8");
    const view = await readFile(new URL("./attestations-view.tsx", import.meta.url), "utf8");
    // The rule caps a declared verification and stops there. Three surfaces
    // stated it as "every non-unavailable claim is shown as an assertion",
    // which was the rule as `assertedState()` mis-implemented it — and which
    // now stands above a matrix that may read "Failed".
    for (const source of [facts, model, view]) {
      expect(source).not.toContain("non-unavailable claim");
      expect(source).toMatch(/declared failure keeps (?:its )?full weight/u);
    }
  });

  it("gives the claim-state legend one word per state in the accessible tree too", async () => {
    const proof = await readFile(new URL("./proof-view.tsx", import.meta.url), "utf8");
    // Left to `SEAL_LABELS`, the `none` dot announced "Not checked" directly
    // before the visible "No evidence": a fifth state word audible only to the
    // readers who cannot see the one beside it.
    expect(proof).toContain('density="dot" size={16} label={entry.word} />{entry.word}');
  });

  it("renders no second verdict-shaped pill beside the Proof route's hero verdict", async () => {
    const inspector = await readFile(new URL("./proof-inspector.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("./shell.css", import.meta.url), "utf8");
    // The chip is gone from the heading and the CSS family retired with it …
    expect(inspector).not.toContain('class="proof-level"');
    expect(styles).not.toContain(".proof-level");
    // … and the declaration it carried is re-presented, under the label that
    // names its author, beside the posture and provider it belongs with.
    expect(inspector).toContain("<dt>Declared proof level</dt><dd>{proofLevelLabel(receipt.proofLevel)}</dd>");
  });

  it("keeps the Google Drive setup on the active Airship design-token vocabulary", async () => {
    const styles = await readFile(new URL("./google-drive-setup.css", import.meta.url), "utf8");
    expect(styles).toContain("var(--density-panel-pad)");
    expect(styles).toContain("var(--surface-soft)");
    expect(styles).not.toMatch(/var\(--(?:space-\d|surface-[01]|text\b|muted\b)/u);
  });
});
