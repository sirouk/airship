/**
 * Prime session event vocabulary alongside the Airship turn protocol.
 * These are journal records for machinery Airship has no turn vocabulary for:
 * runtime selection, kernel jobs, harness records, subagent admission/terminal,
 * agent messages, goals, and compaction notices. They sit beside the transcript
 * and never enter canonical provider history.
 */

import type { JsonValue } from "../../core/contracts";
import type { EventDraft } from "../../core/journal";

export const PRIME_EVENT_TYPES = Object.freeze({
  /*
   * The current marker written before a fresh journal's first Prime turn.
   * The former event name remains accepted only by read-side compatibility
   * code and is intentionally absent from this write vocabulary.
   */
  sessionRuntimeSelected: "prime.session.runtime.selected",
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

