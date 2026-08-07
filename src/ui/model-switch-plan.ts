import { effectiveSessionModel, type SessionRecord } from "../core/journal";

/**
 * Where a chosen Chutes model lands, decided once and in words before any
 * network or journal work begins. The conversation-visible distinction the
 * whole feature exists for: a thread whose manifest pins the live
 * connection changes in place (one durable event, transcript and route
 * untouched), everything else keeps the pinned-fork semantics it had.
 */
export type ChutesModelSwitchPlan =
  | Readonly<{ kind: "noop" }>
  | Readonly<{ kind: "in-place"; session: SessionRecord }>
  | Readonly<{ kind: "fork" }>;

export function planChutesModelSwitch(args: Readonly<{
  /** A reconnect request always takes the audited-reconnect path. */
  reconnectIntent: boolean;
  /** The conversation on screen, when one is open. */
  activeSession?: SessionRecord;
  /** The live connection identity the transport answers to. */
  connectionId?: string;
  /** The connection's own pinned model. */
  connectionModel: string;
  /** True when the connected lane is the active runtime, not a standby. */
  activeConnection: boolean;
  /** The model the person just chose. */
  targetModelId: string;
}>): ChutesModelSwitchPlan {
  const { reconnectIntent, activeSession, connectionId, connectionModel, activeConnection, targetModelId } = args;
  const sameThread = !reconnectIntent
    && activeSession
    && connectionId
    && activeSession.manifest.inferenceBinding?.providerId === "chutes"
    && activeSession.manifest.inferenceBinding.connectionId === connectionId
    ? activeSession
    : undefined;
  /*
   * The record's *effective* model decides no-op, not the connection pin:
   * choosing the pinned model while an override is active is the change
   * "back to the thread's birth model", and must run, not exit.
   */
  if (sameThread) {
    if (targetModelId === effectiveSessionModel(sameThread)) return { kind: "noop" };
    return { kind: "in-place", session: sameThread };
  }
  // No visible thread pins this connection: choosing the model the pinned
  // connection already runs is a no-op, anything else is the fork it was.
  if (!reconnectIntent && activeConnection && targetModelId === connectionModel) {
    return { kind: "noop" };
  }
  return { kind: "fork" };
}

/**
 * The compression gate's trigger, stated as data: the chosen model's window
 * is smaller than what this conversation already uses. An unknown window or
 * an unmeasured thread stays silent — the gate exists to name a consequence
 * it can measure, never to guess at one. Typed as a predicate on the use
 * measurement because the only caller with a true answer is about to quote
 * that number in the consequence sentence.
 */
export function modelSwitchNeedsCompressionGate(
  usedTokens: number | undefined,
  candidateWindowTokens: number | undefined,
): usedTokens is number {
  return usedTokens !== undefined && candidateWindowTokens !== undefined && usedTokens > candidateWindowTokens;
}
