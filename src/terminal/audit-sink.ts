import { TERMINAL_ACTIVITY_EVENT_TYPE } from "../core/contracts";
import type { JsonValue } from "../core/contracts";
import type { TerminalAuditRecord, TerminalSessionSnapshot } from "./contracts";

/**
 * The seam between shell lineage and the session journal.
 *
 * `BrowserTerminalManager` is a page-global singleton created inside the
 * lazily-loaded terminal chunk, three component boundaries below the shell that
 * owns the journal — so "pass a callback down as a prop" would have meant
 * threading one argument through `app.tsx`, `workspace-view.tsx`,
 * `workspace-terminal-dock.tsx` and `terminal-view.tsx`, and any surface that
 * forgot to thread it would silently stop recording. The subscription lives in
 * its own module instead, with no WebContainer or workspace imports, so the
 * shell can bind the journal statically at boot while the manager itself stays
 * behind its chunk.
 *
 * It is a set rather than a single slot on purpose: a second registration must
 * be visible as double-writing, not silently replace the first.
 */
export type TerminalAuditListener = (
  record: TerminalAuditRecord,
  session: TerminalSessionSnapshot,
) => void;

const listeners = new Set<TerminalAuditListener>();

export function subscribeTerminalAuditRecords(listener: TerminalAuditListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Called by the manager for every record it appends. A listener that throws is
 * contained here: journal trouble is the shell's problem to report, and a
 * terminal must not lose its own bounded lineage — or its PTY — because the
 * page failed to write a copy of it somewhere else.
 */
export function publishTerminalAuditRecord(
  record: TerminalAuditRecord,
  session: TerminalSessionSnapshot,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(record, session);
    } catch {
      /* A sink failure is reported by the sink, never by killing the shell. */
    }
  }
}

/**
 * What one shell record looks like as a durable journal event payload.
 *
 * Two things are deliberately absent. `outputTail` — the retained PTY bytes —
 * never crosses into the journal: it is unbounded process output that no
 * redaction pass has ever seen, and the journal is the artifact that gets
 * exported. And there is no turn or operation identity, because a shell command
 * is not a turn step; inventing one would make the audit's turn accounting
 * describe work no model did.
 *
 * `command` does cross, already truncated by the manager, because a lineage
 * that cannot say *what ran* records nothing an auditor can use.
 */
export type TerminalActivityEventPayload = Readonly<{
  version: 1;
  terminalSessionId: string;
  recordId: string;
  sequence: number;
  kind: TerminalAuditRecord["kind"];
  outcome: TerminalAuditRecord["outcome"];
  recordedAt: string;
  processEpoch: number;
  origin: TerminalSessionSnapshot["origin"]["kind"];
  cwd: string;
  summary: string;
  /** Interactive PTY input this Airship-owned sideband answered. */
  sourceRecordId?: string;
  profileId?: string;
  /** Page-unique writer identity; two writers on one terminal is split lineage. */
  writerId?: string;
  command?: string;
  exitCode?: number;
  changedPaths?: readonly string[];
}>;

export function terminalActivityEvent(
  record: TerminalAuditRecord,
  session: TerminalSessionSnapshot,
): Readonly<{ type: typeof TERMINAL_ACTIVITY_EVENT_TYPE; payload: JsonValue }> {
  const payload: TerminalActivityEventPayload = {
    version: 1,
    terminalSessionId: session.id,
    recordId: record.id,
    sequence: record.sequence,
    kind: record.kind,
    outcome: record.outcome,
    recordedAt: record.recordedAt,
    processEpoch: record.processEpoch,
    origin: session.origin.kind,
    cwd: session.cwd,
    summary: record.summary,
    ...(record.sourceRecordId ? { sourceRecordId: record.sourceRecordId } : {}),
    ...(session.profileId ? { profileId: session.profileId } : {}),
    ...(record.writerId ? { writerId: record.writerId } : {}),
    ...(record.command ? { command: record.command } : {}),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.changedPaths ? { changedPaths: [...record.changedPaths] } : {}),
  };
  return Object.freeze({
    type: TERMINAL_ACTIVITY_EVENT_TYPE,
    payload: payload as unknown as JsonValue,
  });
}
