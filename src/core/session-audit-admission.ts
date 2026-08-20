import type { SessionAuditReport } from "./session-audit";

/**
 * Whether an audit refuses to hand this history back to the reader.
 *
 * Only `invalid` does. That status means an error-severity finding: the
 * journal contradicts itself — a broken digest chain, a protocol violation, a
 * head that does not match its commitment. That is the integrity claim this
 * product actually makes, and it is worth refusing a resume over.
 *
 * `incomplete` is not that claim and never was. It means the audit met records
 * it does not interpret: an event type from a newer build, an operation whose
 * outcome was never journaled, or — by far the commonest case — a turn with no
 * terminal, which is exactly what a cancelled turn and a turn still in flight
 * both look like. Requiring `verified` to open a conversation therefore
 * quarantined people from threads that were merely *unfinished*, including the
 * one they had just been talking in, while the panel beside the button read
 * "Ready to resume · Fork not required" from a different code path that had
 * judged the same journal fine.
 *
 * Nothing is hidden by this. The findings still render and session inspection still
 * opens on them, and a history that fails integrity is still refused. The
 * observation was always worth showing; it was never worth locking the door.
 *
 * WHY THIS IS ITS OWN FILE, and it is not tidiness: `session-audit.ts` is a
 * deferred capability. The shell reaches `auditSessionHistory` through
 * `loadDeferredCapabilities()` precisely so a page that never opens an old
 * conversation never pays for the audit engine. Importing this predicate as a
 * *value* from that module pulled the whole engine into the eager baseline
 * bundle — +9 KiB gzip, caught by the release gate. The type import above is
 * erased at build time, so this file costs the bundle nothing while keeping
 * one definition of the rule.
 */
export function sessionAuditRefusesResume(report: Pick<SessionAuditReport, "status">): boolean {
  return report.status === "invalid";
}
