import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SessionAuditReport } from "../core/session-audit";
import { answerProvenanceReading, journalAuditReading, missingReceiptReading, recordedActivityFacts } from "./proof-view";

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

/** Only `counts` is read; the rest of the report is not this unit's input. */
function counted(counts: Partial<SessionAuditReport["counts"]>): SessionAuditReport {
  return {
    counts: {
      events: 0,
      turns: 0,
      completedTurns: 0,
      failedTurns: 0,
      cancelledTurns: 0,
      toolOperations: 0,
      terminalToolOperations: 0,
      localCommands: 0,
      terminalLocalCommands: 0,
      shellRecords: 0,
      // The fixture is cast to the report type, so a field added to `counts`
      // that is missing here reaches the renderer as `undefined` and prints
      // "undefined decided" rather than failing the cast. Every field the
      // ledger reads has a zero here for that reason.
      humanIntentDecisions: 0,
      humanIntentAllowed: 0,
      unknownEvents: 0,
      ...counts,
    },
  } as unknown as SessionAuditReport;
}

/*
 * The Proof route reported one code path and called it the session.
 *
 * Measured on the running build at 1440×900 and 390×844: after staging and
 * committing README.md under two "Allow once" approvals, `#proof` rendered
 * "No evidence — Evidence is recorded when a turn completes. Complete a turn to
 * create the first local receipt." while its own audit report, in the same
 * component's state, carried `counts.events === 4`. After two local slash
 * commands the transcript printed "COMPLETED TURN" and the same panel printed
 * the same sentence over `counts.localCommands === 1`.
 */
describe("what Proof says about a session with no turn receipt", () => {
  it("never instructs a person who has already recorded work to complete a turn", () => {
    // The Git journey, verbatim from the audit it exported.
    const gitSession = missingReceiptReading(counted({ events: 4 }), undefined);

    expect(gitSession).not.toContain("Complete a turn");
    expect(gitSession).toContain("4 recorded events");
  });

  it("keeps the imperative for the session it is actually true of", () => {
    // No audited journal to speak for the session: loading, unreadable, or no
    // session at all. The route may not report counts it does not have.
    expect(missingReceiptReading(undefined, undefined)).toBe("Complete a turn to create the first local receipt.");
    expect(missingReceiptReading(counted({ events: 0 }), undefined)).toBe("Complete a turn to create the first local receipt.");
  });

  it("names a local command turn as the completion that mints no receipt", () => {
    const local = missingReceiptReading(counted({ events: 5, localCommands: 1, terminalLocalCommands: 1 }), undefined);

    // The contradiction this closes: "COMPLETED TURN" in the transcript against
    // "no turn has completed" here, for one and the same turn.
    expect(local).toContain("1 local command");
    expect(local).toContain("called no provider");
    expect(local).not.toContain("Complete a turn");
  });

  it("does not deny a completed turn when only the receipt is missing", () => {
    const resumed = missingReceiptReading(counted({ events: 11, turns: 1, completedTurns: 1 }), undefined);

    expect(resumed).toContain("1 completed turn");
    expect(resumed).toContain("no turn receipt is loaded for this view");
  });

  it("still refuses to substitute a different receipt for a requested one", () => {
    expect(missingReceiptReading(counted({ events: 9 }), "urn:airship:receipt:absent"))
      .toBe("The selected receipt is not available in this page runtime. Airship will not substitute a different turn receipt.");
  });
});

describe("the recorded-work ledger", () => {
  it("reports every kind of recorded work, zeros included", () => {
    // TRM-06's rule, now applied to all five: a count of zero is a fact, and a
    // missing row is what let a session with unreported work look like a
    // session with none. "Approved by you" is the fifth because a session whose
    // only work was two approved Git commits used to render four zeros.
    expect(recordedActivityFacts(counted({ events: 4 }).counts).map((fact) => fact.label))
      .toEqual(["Provider turns", "Tool operations", "Local commands", "Shell records", "Approved by you"]);
  });

  it("says nothing at all when there is no audited journal to count", () => {
    expect(recordedActivityFacts(undefined)).toEqual([]);
  });

  it("folds each kind's terminal count into its own row", () => {
    const facts = recordedActivityFacts(counted({
      events: 24,
      turns: 3,
      completedTurns: 2,
      failedTurns: 1,
      toolOperations: 4,
      terminalToolOperations: 3,
      localCommands: 2,
      terminalLocalCommands: 2,
      shellRecords: 7,
    }).counts);
    const value = (label: string) => facts.find((fact) => fact.label === label)?.value;

    expect(value("Provider turns")).toBe("3 started · 2 completed · 1 failed");
    expect(value("Tool operations")).toBe("4 requested · 3 finished");
    expect(value("Local commands")).toBe("2 run on this device · 2 finished");
    expect(value("Shell records")).toBe("7");
  });

  it("omits an outcome nothing was recorded for, rather than printing a zero that implies a record", () => {
    // One turn in flight: started, no terminal event written yet.
    expect(recordedActivityFacts(counted({ events: 3, turns: 1 }).counts)[0]?.value).toBe("1 started");
  });

  it("drops the breakdown at zero, where it adds no fact", () => {
    expect(recordedActivityFacts(counted({ events: 4 }).counts).map((fact) => fact.value))
      .toEqual(["0", "0", "0", "0", "0"]);
  });

  it("stands beside the verdict, not inside a panel that collapses when the structure passes", () => {
    expect(source).toContain('<dl class="proof-posture" aria-label="Work recorded in this session’s journal">');
    // The journal disclosure keeps the facts about the check itself and no
    // longer carries the one recorded-work count that used to hide in it.
    expect(source).not.toContain("<dt>Shell records</dt>");
    expect(source).toContain("<dt>Journal events</dt>");
  });

  it("states what the completeness check can and cannot show", () => {
    // `checks.complete` is the absence of a completeness finding about the
    // events that are present; the exported audit's `"complete": true` was read
    // as "everything that happened is in here".
    expect(source).toContain("“Complete history” means no gap was found among the events that are present; it cannot show that an effect which was never recorded is missing.");
  });

  /*
   * The row used to be a constant: "Not bound to this receipt. A turn's
   * selected sources are journal records." True, and useless — it named an
   * absence without naming where the thing actually is, and nothing in the
   * product rendered the selection it pointed at. It now reads the sealed
   * `turn.context.selected` record, and the three states it distinguishes are
   * three different facts.
   */
  it("names what the answer was selected from, or says which absence it is", () => {
    expect(source).toContain("<dt>Answer provenance</dt><dd>{answerProvenanceReading(scopedTurn, Boolean(journal))}</dd>");
  });

  it("distinguishes 'not read yet' from 'no sources' from 'these sources'", () => {
    const row = (grounding: readonly { path: string }[], bytes?: number) => ({
      id: "t", kind: "provider-turn" as const, sequence: 1, recordedAt: "2026-07-31T00:00:00.000Z",
      turnId: "t", title: "q", outcome: "completed" as const, outcomeLabel: "Completed",
      ...(bytes === undefined ? {} : { groundingBytes: bytes }),
      grounding: grounding as never, facts: [],
    });
    expect(answerProvenanceReading(undefined, false)).toMatch(/Reading this session's journal/u);
    expect(answerProvenanceReading(undefined, true)).toMatch(/not in the journal read for this view/u);
    expect(answerProvenanceReading(row([]), true)).toMatch(/No sources were selected for this turn/u);
    const named = answerProvenanceReading(row([{ path: "notes/retrieval.md" }, { path: "README.md" }], 1_132), true);
    expect(named).toContain("2 sources selected and journaled");
    expect(named).toContain("1,132 bytes");
    expect(named).toMatch(/Path, revision, chunk and content digest/u);
  });
});
