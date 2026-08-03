import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
const sessionsView = await readFile(new URL("./sessions-view.tsx", import.meta.url), "utf8");

/**
 * Two defects a judge reproduced live on the vault adoption path.
 *
 * The first is the worst class this product has: one `try` covered the
 * inspect, the read, the digest audit AND the presentation, so a session whose
 * audit returned `invalid` still reached a panel headed "History verified" that
 * said "every event is intact" — rendered three lines above the product's own
 * "History suspect". The claim has to be gated on the audit actually returning
 * `verified`, not on having reached the catch.
 *
 * The second silently dropped a durable record: library resume gated on
 * `rows.length`, and a marker is not a row, so a conversation whose only
 * presentable content was a session-scoped event came back as welcome copy.
 */
describe("quarantine and resume honesty", () => {
  it("only claims a verified history when the audit established one", () => {
    // The flag has to be initialised false and raised *after* the audit check,
    // otherwise it says nothing the catch did not already know.
    expect(app).toContain("let historyVerified = false;");
    const raise = app.indexOf("historyVerified = true;");
    const auditCheck = app.indexOf('if (audit.status !== "verified")');
    expect(auditCheck, "the audit gate must exist").toBeGreaterThan(-1);
    expect(raise, "the flag must be raised after the audit gate").toBeGreaterThan(auditCheck);

    // And it must travel with the quarantine record rather than being
    // recomputed. `??=`, because adoption now walks the whole shelf of
    // resumable conversations and the *first* failure — the one the person was
    // last in — is the one reported, rather than the last one tried.
    expect(app).toMatch(/quarantined \?\?= Object\.freeze\(\{[^}]*historyVerified/su);
  });

  it("never prints the intact-history sentence unconditionally", () => {
    // Both the heading and the body were unconditional string literals.
    expect(sessionsView).toContain("quarantine.historyVerified");
    // The full sentence, not the fragment: the fragment also appears in the
    // comment above the fix explaining what went wrong, which sits before the
    // guard and made this assertion match its own documentation.
    const intact = "The digest chain passed its audit and every event is intact.";
    const index = sessionsView.indexOf(intact);
    expect(index, "the sentence should still exist for the case where it is true").toBeGreaterThan(-1);

    // The paragraph that carries the claim must itself open with the guard, and
    // the guard must be the nearest thing before the sentence — a comment
    // mentioning it does not count.
    const paragraph = sessionsView.lastIndexOf("<p>", index);
    const guard = sessionsView.lastIndexOf("quarantine.historyVerified", index);
    expect(guard, "the intact claim must sit inside a historyVerified branch").toBeGreaterThan(paragraph);
    expect(sessionsView.slice(paragraph, paragraph + 32)).toContain("{quarantine.historyVerified");
  });

  it("counts markers as content when resuming, so a durable record is not replaced by welcome copy", () => {
    expect(app).toContain("presentation.rows.length + presentation.markers.length > 0");
    expect(app).not.toMatch(/setMessages\(presentation\.rows\.length > 0/u);
  });
});
