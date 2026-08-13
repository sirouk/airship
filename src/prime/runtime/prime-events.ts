/**
 * Prime session event vocabulary alongside the airship turn protocol.
 * These are journaled evidence records for machinery airship has no turn
 * vocabulary for: kernel jobs, harness records, subagent
 * admission/terminal, agent messages, goals, compaction notices. They sit
 * beside the transcript — never inside the canonical provider history —
 * so the transcript audit stays byte-clean.
 */

import type { JsonValue } from "../../core/contracts";
import type { EventDraft } from "../../core/journal";

export const PRIME_EVENT_TYPES = Object.freeze({
  /*
   * The first prime turn's durable statement that this session runs prime.
   * `runPrimeTurn` wrote this string inline while this vocabulary did not name
   * it, so the one prime record every prime session is guaranteed to carry was
   * the one record no shared list knew about — which is how it reached
   * `session-audit.ts` as an unknown type.
   */
  sessionRuntimeSeal: "prime.session.runtime.seal",
  harnessRefined: "prime.harness.refined",
  kernelJobStarted: "prime.kernel.job.started",
  kernelJobCompleted: "prime.kernel.job.completed",
  kernelJobFailed: "prime.kernel.job.failed",
  kernelJobCancelled: "prime.kernel.job.cancelled",
  kernelJobCrashed: "prime.kernel.job.crashed",
  kernelToolRequested: "prime.kernel.tool.requested",
  kernelToolApproved: "prime.kernel.tool.approved",
  kernelToolDenied: "prime.kernel.tool.denied",
  kernelToolResulted: "prime.kernel.tool.resulted",
  kernelToolFailed: "prime.kernel.tool.failed",
  agentMessage: "prime.agent_message.sent",
  goalUpdated: "prime.goal.updated",
  compacted: "prime.compacted",
  customNotice: "prime.notice",
} as const);

export function noticeDraft(notice: string, detail?: JsonValue): EventDraft {
  return {
    type: PRIME_EVENT_TYPES.customNotice,
    payload: detail === undefined ? { notice } : { notice, detail },
  };
}

