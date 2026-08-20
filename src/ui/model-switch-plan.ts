import { effectiveSessionModel, type SessionRecord } from "../core/journal";

/**
 * Where a chosen model lands, decided once and in words before any journal
 * work begins. Switching a conversation's model is one in-place durable
 * override event on the thread itself — the same plan for every provider.
 * There is no fork arm: forking is an explicit user action, never a side
 * effect of choosing a model.
 */
export type ModelSwitchPlan =
  | Readonly<{ kind: "noop" }>
  | Readonly<{ kind: "in-place"; session: SessionRecord }>;

export function planModelSwitch(args: Readonly<{
  /** The conversation on screen, when one is open. */
  activeSession?: SessionRecord;
  /** The model the person just chose. */
  targetModelId: string;
}>): ModelSwitchPlan {
  const { activeSession, targetModelId } = args;
  if (!activeSession) return { kind: "noop" };
  /*
   * The record's *effective* model decides no-op, not the manifest pin:
   * choosing the birth model while an override is active is the change
   * "back to the thread's birth model", and must run, not exit.
   */
  if (targetModelId === effectiveSessionModel(activeSession)) return { kind: "noop" };
  return { kind: "in-place", session: activeSession };
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
