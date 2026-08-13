/**
 * The engine-status authority for one session's journal.
 *
 * Two surfaces must never disagree about which engine owns a session: the
 * turn gate in `src/load-agent-runtime.ts`, which routes each turn onto an
 * engine, and whatever is rendered beside a conversation's title. The gate's
 * rule is durable evidence — any `prime.*` record pins the session to prime,
 * airship turn-protocol records pin it to airship-core, and a journal with
 * neither is unclaimed land that runs whichever engine the gate's unpinned
 * branch currently selects. This module is the
 * read-side of that same rule: it imports the gate's `sessionRuntimeKind`
 * rather than restating it, narrows *which* prime evidence pinned (the
 * first-turn seal versus later prime records), and states what a person can
 * do about a pin they did not choose — fork, because an engine flip
 * mid-history forks the evidence chain, so the remedy is a new session
 * carrying the history, never a switch inside this one.
 */

import { sessionRuntimeKind } from "../../load-agent-runtime";

/**
 * The engine a session's journal has durably pinned it to. `null` where the
 * journal carries no engine evidence: the default engine runs, but nothing
 * is pinned until the first engine-producing record lands.
 */
export type PinnedAgentEngine = "prime" | "airship-core";

/**
 * `agent-runtimes` widens its ledger to *any* array of typed events, so both
 * view code handing over `DurableEvent`s and tests passing literals share
 * the same derivation.
 */
export type AgentRuntimeStatusLedger = Readonly<{
  sessionId: string;
  events: readonly Readonly<{ type: string }>[];
  /**
   * Present in the shape for the view, which already holds the session
   * record; the derivation is deliberately journal-evidence only, mirroring
   * the gate.
   */
  manifest?: unknown;
}>;

/**
 * Which record class carried the pin, strongest first. `"seal"` and
 * `"prime-events"` both pin prime; the seal is the first turn's durable
 * statement of the decision and is the one the Proof view reads, so it is
 * named when present. `"empty"` covers every journal with no engine
 * evidence — including a fresh one holding just its creation record.
 */
export type AgentRuntimeStatusEvidence = "seal" | "prime-events" | "airship-history" | "empty";

export type AgentRuntimeStatus = Readonly<{
  /** The engine journal evidence pins, or `null` while nothing is pinned. */
  pinnedEngine: PinnedAgentEngine | null;
  /**
   * What actually runs when nothing is pinned. Not a preference — the gate's
   * answer, read off `src/load-agent-runtime.ts`: an unpinned journal takes
   * the airship-core lane whenever a transport is attached, and `transport`
   * is a required field of `RunTurnOptions`, so every unpinned session the
   * shipped app starts routes there. It flips back to prime when
   * `runPrimeTurn` is taught to forward the vendor stream and its key getter
   * and that branch goes away; carried as a value so renderers keep reading
   * the gate instead of hardcoding an engine name.
   */
  defaultEngine: PinnedAgentEngine;
  evidenceType: AgentRuntimeStatusEvidence;
  /**
   * Whether switching engines is possible at all for this session. Pinned:
   * yes, exactly one way — fork. Unpinned: no; there is no other engine to
   * switch away from, because this journal pins nothing yet.
   */
  canForkSwitch: boolean;
  /** The remedy sentence, only where the question has a pinned answer to remedy. */
  forkRemedy?: string;
}>;

/**
 * The record `runPrimeTurn` lands before anything else on a session's first
 * prime turn (`src/prime/runtime/runtime.ts`). The writer owns the payload;
 * this module owns the read. The literal is pinned by the colocated test so
 * the two cannot drift apart silently.
 */
export const AGENT_RUNTIME_SEAL_EVENT_TYPE = "prime.session.runtime.seal";

export function getAgentRuntimeStatus(ledger: AgentRuntimeStatusLedger): AgentRuntimeStatus {
  const kind = sessionRuntimeKind(ledger.events);
  if (kind === "unpinned") {
    return Object.freeze({
      pinnedEngine: null,
      defaultEngine: "prime",
      evidenceType: "empty",
      canForkSwitch: false,
    });
  }
  const sealed = kind === "prime"
    && ledger.events.some((event) => event.type === AGENT_RUNTIME_SEAL_EVENT_TYPE);
  const other: PinnedAgentEngine = kind === "prime" ? "airship-core" : "prime";
  return Object.freeze({
    pinnedEngine: kind,
    defaultEngine: "prime",
    evidenceType: sealed ? "seal" : kind === "prime" ? "prime-events" : "airship-history",
    canForkSwitch: true,
    // Verbatim remedy vocabulary of the gate's refusals, so the status and
    // the refusal a person meets after ignoring it read as one system.
    forkRemedy: `fork the session to use the ${other} engine.`,
  });
}

/**
 * The one-line honest statement of who owns this session's engine, for the
 * tag beside a conversation's title.
 */
export function formatAgentRuntimeStatusLine(status: AgentRuntimeStatus): string {
  if (status.pinnedEngine === null) return `engine: ${status.defaultEngine} (default)`;
  return `engine: ${status.pinnedEngine} (pinned by journal evidence — fork the session to switch)`;
}
