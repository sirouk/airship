import type { DurableEvent, SessionRecord } from "../core/journal";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import {
  DEFAULT_SESSION_INSPECTION_LIMITS,
  sessionHistoryLabel,
  type SessionHistoryAssessment,
  type SessionHistoryIssue,
  type SessionInspectionLimits,
} from "./domain";

export type AssessmentProgress = Readonly<{ checked: number; total: number }>;
export type AsyncAssessmentOptions = Readonly<{ limits?: Partial<SessionInspectionLimits>; snapshotStable?: boolean; signal?: AbortSignal; onProgress?: (progress: AssessmentProgress) => void }>;

export async function assessSessionHistoryAsync(session: SessionRecord, events: readonly DurableEvent[], options: AsyncAssessmentOptions = {}): Promise<SessionHistoryAssessment> {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Audit cancelled.", "AbortError");
  const limits = resolveAssessmentLimits(options.limits);
  options.onProgress?.({ checked: 0, total: events.length });
  await yieldForAssessment(options.signal);
  const { auditSessionHistory } = await loadDeferredCapabilities();
  throwIfAborted(options.signal);
  const report = await auditSessionHistory(
    { session, events },
    { limits: { maxEvents: limits.maxEvents } },
  );
  throwIfAborted(options.signal);
  const result = assessmentFromAudit(report, events.length, limits.maxEvents, options.snapshotStable);
  options.onProgress?.({ checked: result.checkedEvents, total: events.length });
  return result;
}

type AuditReport = Awaited<ReturnType<typeof import("../core/session-audit")["auditSessionHistory"]>>;

/**
 * The Sessions UI keeps a deliberately smaller compatibility contract than
 * the forensic audit. Adapt the stronger report instead of shipping a second
 * structural-audit implementation in a worker.
 */
export function assessmentFromAudit(
  report: AuditReport,
  totalEvents: number,
  maxEvents: number,
  snapshotStable = true,
): SessionHistoryAssessment {
  const inspectionWasBounded = totalEvents > maxEvents;
  const issues: SessionHistoryIssue[] = report.findings.map((finding) => Object.freeze({
    code: finding.code,
    severity: finding.severity === "error" && !(
      inspectionWasBounded && (
        finding.code === "EVENT_LIMIT_EXCEEDED" ||
        finding.code === "SESSION_HEAD_MISMATCH" ||
        finding.code === "SESSION_UPDATED_AT_MISMATCH"
      )
    ) ? "error" : "warning",
    message: finding.message,
    ...(finding.sequence === undefined ? {} : { sequence: finding.sequence }),
    ...(finding.turnId === undefined ? {} : { turnId: finding.turnId }),
  }));
  if (!snapshotStable) {
    issues.push(Object.freeze({
      code: "SNAPSHOT_CHANGED_DURING_READ",
      severity: "warning",
      message: "The session advanced while it was being read. Refresh before resuming.",
    }));
  }
  const status = issues.some((issue) => issue.severity === "error")
    ? "suspect"
    : issues.length > 0
      ? "incomplete"
      : "consistent";
  return Object.freeze({
    status,
    label: sessionHistoryLabel(status, issues, Math.min(totalEvents, maxEvents), totalEvents),
    verification: Object.freeze({
      scope: "structural-linkage-only",
      digestRecomputed: false,
      authenticity: "not-proven",
    }),
    checkedEvents: Math.min(totalEvents, maxEvents),
    totalEvents,
    turnCount: report.counts.turns,
    completedTurnCount: report.counts.completedTurns,
    issues: Object.freeze(issues),
  });
}

function resolveAssessmentLimits(overrides: Partial<SessionInspectionLimits> | undefined): SessionInspectionLimits {
  const limits = { ...DEFAULT_SESSION_INSPECTION_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return Object.freeze(limits);
}

async function yieldForAssessment(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler?.yield) await scheduler.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Audit cancelled.", "AbortError");
}
