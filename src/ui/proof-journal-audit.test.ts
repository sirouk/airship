import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SessionAuditReport } from "../core/session-audit";
import { journalAuditReading } from "./proof-view";

const source = await readFile(new URL("./proof-view.tsx", import.meta.url), "utf8");

/** Only `status` and `findings.length` are read; the rest is not this unit's input. */
function report(status: SessionAuditReport["status"], findings = 0): SessionAuditReport {
  return { status, findings: Array.from({ length: findings }, () => ({})) } as unknown as SessionAuditReport;
}

/*
 * A journal that could not be read is not a journal that was never checked.
 *
 * Measured: when `loadAudit` rejected, `audit` stayed undefined, the headline
 * fell through to "Not checked" and the seal to `none` — byte-for-byte the
 * rendering used when there is no session at all — while the error text was
 * demoted into the same polite paragraph that holds "No active session is
 * available to audit.". On the one surface that exists to say whether a record
 * is intact, an unreadable encrypted journal looked benign, and there was no
 * control anywhere that re-ran the check.
 */
describe("journal audit reading", () => {
  it("never renders a failed read as the never-attempted one", () => {
    const failed = journalAuditReading(undefined, false, true);
    const idle = journalAuditReading(undefined, false, false);

    expect(failed.label).not.toBe(idle.label);
    expect(failed.label).toBe("Journal could not be read");
    expect(failed.seal).not.toBe("none");
    expect(failed.seal).toBe("attention");
  });

  it("leaves the no-session rendering exactly as it was", () => {
    expect(journalAuditReading(undefined, false, false)).toEqual({ label: "Not checked", seal: "none" });
    expect(journalAuditReading(undefined, true, false)).toEqual({ label: "Checking journal", seal: "checking" });
    // An in-flight retry is a check in progress, not a standing failure.
    expect(journalAuditReading(undefined, true, true).label).toBe("Checking journal");
  });

  it("keeps the word and the seal in one decision, so the row cannot say two things", () => {
    expect(journalAuditReading(report("verified"), false, false)).toEqual({ label: "Journal structure passed", seal: "verified" });
    // A structure that passed while carrying a warning is not the same artifact
    // as one with no findings, and the resting row is where that is learned.
    expect(journalAuditReading(report("verified", 2), false, false)).toEqual({ label: "Journal structure passed", seal: "attention" });
    expect(journalAuditReading(report("incomplete"), false, false)).toEqual({ label: "Consistent but incomplete", seal: "attention" });
    expect(journalAuditReading(report("invalid"), false, false)).toEqual({ label: "Integrity failure", seal: "failed" });
  });

  it("gives the failure its own assertive element and a control that re-runs it", () => {
    expect(source).toContain("const auditReading = journalAuditReading(audit, auditLoading, Boolean(auditError));");
    expect(source).toContain("<Seal state={auditReading.seal}");
    expect(source).toContain('<p role="alert"><Icon name="warning" size={16} /> {auditError}</p>');
    expect(source).toContain("onClick={() => setAuditAttempt((value) => value + 1)}");
    // The nonce is a dependency of the effect that calls `loadAudit(sessionId)`,
    // which is the whole point: the same session is audited again.
    expect(source).toContain("}, [sessionId, eventCount, auditAttempt]);");
    // The idle sentence no longer shares its element with the failure.
    expect(source).toContain('<p class="audit-loading" role="status">{auditLoading ? "Recomputing the session commitment…" : "No active session is available to audit."}</p>');
  });
});
