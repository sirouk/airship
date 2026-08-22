import type { SessionAuditReport } from "./session-audit";

/**
 * Whether an audit refuses to hand this history back to the reader.
 *
 * Only an `error` finding does, and `error` now means one thing: this record
 * cannot be appended to. The chain does not link, an event is not the event
 * its digest says it is, or the head does not match the events under it — so
 * the next turn would anchor itself to something that is not there. That is
 * the integrity claim this product actually makes, and it is worth refusing a
 * resume over.
 *
 * This used to read `report.status === "invalid"`, which was a much wider net
 * than the paragraph above described. `status` is still exactly as strict as
 * it ever was and every path that *copies* a journal — seeding a fork, taking
 * an audited prefix, adopting a vault's latest conversation — still reads it
 * and still refuses the same journals. But a manifest whose tool digest moved,
 * a rename event with a malformed title, an approval whose provenance is thin:
 * those are contradictions to show, not reasons to take a finished
 * conversation away from the person who had it. Reading is not copying.
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
export function sessionAuditRefusesResume(report: Pick<SessionAuditReport, "appendable">): boolean {
  return !report.appendable;
}
