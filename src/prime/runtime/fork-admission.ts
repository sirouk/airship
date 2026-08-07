/**
 * W3 fork-context admission for the prime session authority.
 *
 * A forked session inherits provider-visible context through exactly one
 * durable commitment: the `session.fork.context.seeded` event pinned at
 * journal position 1 and bound to the manifest lineage. This module decides
 * whether that evidence admits the inherited context, mirroring the
 * core/agent.ts `runTurn` checks sentence-for-sentence — the protocol-v1
 * replay-only gate and `assertForkContextHistoryCompatible` — so a prime
 * turn refuses with the same bytes a direct airship turn would.
 *
 * The gate is pure evidence work over the passed journal ledger and never
 * touches the journal, so the session wiring can run it before any turn side
 * effect exists and throw the returned reason unchanged.
 */

import type { SessionManifest } from "../../core/contracts";
import {
  FORK_CONTEXT_EVENT_TYPE,
  canonicalForkContextSeed,
  forkContextSeedMatchesScope,
  verifyForkContextSeed,
  type ForkContextScope,
} from "../../core/fork-context";
import type { DurableEvent } from "../../core/journal";

export type PrimeForkAdmissionLedger = Readonly<{
  sessionId: string;
  events: readonly DurableEvent[];
  manifest: SessionManifest;
}>;

/** The exact materializeMessages options core/agent.ts passes for lineage-pinned sessions. */
export type PrimeForkMaterializeOptions = Readonly<{
  allowEmbeddedContext: boolean;
  allowSelectedContext: boolean;
  forkContextScope: ForkContextScope;
  verifiedForkContextDigest?: string;
}>;

export type PrimeForkAdmission =
  | Readonly<{
    ok: true;
    verifiedForkContextDigest: string | undefined;
    forkContextScope: ForkContextScope;
    materializeOptions: PrimeForkMaterializeOptions;
  }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Admit fork-context evidence for a prompt against this ledger. The
 * protocol-v1 gate runs first, exactly as in core `runTurn`: a prompt
 * attempted against v1 lineage evidence is replay-only, and the refusal
 * names that rule rather than any seed finding.
 */
export async function admitPrimeForkContext(
  ledger: PrimeForkAdmissionLedger,
): Promise<PrimeForkAdmission> {
  if (ledger.manifest.protocolVersion === 1) {
    return {
      ok: false,
      reason: "Protocol-v1 sessions are replay-only; fork the session before starting a new turn.",
    };
  }
  const forkContextScope: ForkContextScope = {
    sessionId: ledger.sessionId,
    lineage: ledger.manifest.lineage,
  };
  const verified = await verifyPrimeForkContextHistory(ledger.events, forkContextScope);
  if (!verified.ok) return verified;
  const verifiedForkContextDigest = verified.verifiedForkContextDigest;
  return {
    ok: true,
    verifiedForkContextDigest,
    forkContextScope,
    materializeOptions: primeMaterializeForkOptions({
      sessionId: ledger.sessionId,
      manifest: ledger.manifest,
      verifiedForkContextDigest,
    }),
  };
}

/** Mirrors the option literals at core/agent.ts `runTurn`'s materialize call sites. */
export function primeMaterializeForkOptions(args: Readonly<{
  sessionId: string;
  manifest: SessionManifest;
  verifiedForkContextDigest?: string;
}>): PrimeForkMaterializeOptions {
  return {
    allowEmbeddedContext: args.manifest.turnContext === undefined,
    allowSelectedContext: args.manifest.turnContext !== "disabled",
    forkContextScope: { sessionId: args.sessionId, lineage: args.manifest.lineage },
    verifiedForkContextDigest: args.verifiedForkContextDigest,
  };
}

/* Mirror of core/agent.ts assertForkContextHistoryCompatible, returning the
 * refusal sentence instead of throwing it. */
async function verifyPrimeForkContextHistory(
  events: readonly DurableEvent[],
  scope: ForkContextScope,
): Promise<
  | Readonly<{ ok: true; verifiedForkContextDigest: string | undefined }>
  | Readonly<{ ok: false; reason: string }>
> {
  const seedEvents = events.filter((event) => event.type === FORK_CONTEXT_EVENT_TYPE);
  if (!scope.lineage) {
    if (seedEvents.length > 0) {
      return { ok: false, reason: "A non-fork session contains fork-context seed material." };
    }
    return { ok: true, verifiedForkContextDigest: undefined };
  }
  const event = seedEvents.length === 1 ? seedEvents[0] : undefined;
  if (
    !event ||
    events[1]?.eventId !== event.eventId ||
    event.sessionId !== scope.sessionId ||
    event.turnId !== undefined ||
    event.operationId !== undefined
  ) {
    return { ok: false, reason: "A fork session is missing its unique initial context-seed commitment." };
  }
  const seed = canonicalForkContextSeed(event.payload);
  if (!seed || !forkContextSeedMatchesScope(seed, scope) || !(await verifyForkContextSeed(seed))) {
    return {
      ok: false,
      reason: "The fork-context seed is malformed, out of scope, or has a digest mismatch.",
    };
  }
  return { ok: true, verifiedForkContextDigest: seed.contextDigest };
}
