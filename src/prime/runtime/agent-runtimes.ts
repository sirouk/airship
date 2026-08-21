/**
 * The engine-status authority for one session's journal.
 *
 * Two surfaces must never disagree about which engine owns a session: the
 * turn gate in `src/load-agent-runtime.ts`, which routes each turn onto an
 * engine, and whatever is rendered beside a conversation's title. Any
 * `prime.*` record pins the session to Prime, Airship turn-protocol records
 * pin it to airship-core, and a journal with neither is unclaimed land that
 * runs the gate's unpinned selection. This module reads that same rule rather
 * than restating it. It also reports which record class carried the pin and
 * keeps the engine-switch remedy unchanged: fork to a new session, never
 * switch engines inside this history.
 */

import { sessionRuntimeKind } from "../../load-agent-runtime";
import { PRIME_EVENT_TYPES } from "./prime-events";

/**
 * The engine a session's journal has durably pinned it to. `null` where the
 * journal carries no engine-selection record: the default engine runs, but
 * nothing is pinned until the first engine-producing record lands.
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
   * record; the derivation deliberately uses journal records only, mirroring
   * the gate.
   */
  manifest?: unknown;
}>;

/**
 * Which record class carried the pin, strongest first. The current selection
 * marker is reported separately from the historical marker so callers can
 * handle old journals without presenting either marker as a trust claim.
 */
export type AgentRuntimeStatusRecord =
  | "selection-marker"
  | "legacy-selection-marker"
  | "prime-records"
  | "airship-history"
  | "empty";

export type AgentRuntimeStatus = Readonly<{
  /** The engine journal records pin, or `null` while nothing is pinned. */
  pinnedEngine: PinnedAgentEngine | null;
  /**
   * What actually runs when nothing is pinned. This is the gate's current
   * answer, not a user preference. It is carried as a value so renderers do
   * not hardcode a different default.
   */
  defaultEngine: PinnedAgentEngine;
  recordType: AgentRuntimeStatusRecord;
  /**
   * Whether switching engines is possible at all for this session. Pinned:
   * yes, exactly one way — fork. Unpinned: no; there is no other engine to
   * switch away from, because this journal pins nothing yet.
   */
  canForkSwitch: boolean;
  /** The remedy sentence, only where the question has a pinned answer to remedy. */
  forkRemedy?: string;
}>;

/** The marker `runPrimeTurn` writes before a fresh journal's first Prime turn. */
export const AGENT_RUNTIME_SELECTION_EVENT_TYPE = PRIME_EVENT_TYPES.sessionRuntimeSelected;

/* Read-only compatibility. No writer imports or exports this historical name. */
const LEGACY_AGENT_RUNTIME_SELECTION_EVENT_TYPE = "prime.session.runtime.seal";

export function getAgentRuntimeStatus(ledger: AgentRuntimeStatusLedger): AgentRuntimeStatus {
  const kind = sessionRuntimeKind(ledger.events);
  if (kind === "unpinned") {
    return Object.freeze({
      pinnedEngine: null,
      defaultEngine: "prime",
      recordType: "empty",
      canForkSwitch: false,
    });
  }
  const hasCurrentSelectionMarker = kind === "prime"
    && ledger.events.some((event) => event.type === AGENT_RUNTIME_SELECTION_EVENT_TYPE);
  const hasLegacySelectionMarker = kind === "prime"
    && ledger.events.some((event) => event.type === LEGACY_AGENT_RUNTIME_SELECTION_EVENT_TYPE);
  const other: PinnedAgentEngine = kind === "prime" ? "airship-core" : "prime";
  return Object.freeze({
    pinnedEngine: kind,
    defaultEngine: "prime",
    recordType: hasCurrentSelectionMarker
      ? "selection-marker"
      : hasLegacySelectionMarker
        ? "legacy-selection-marker"
        : kind === "prime"
          ? "prime-records"
          : "airship-history",
    canForkSwitch: true,
    // Verbatim remedy vocabulary of the gate's refusals, so the status and
    // the refusal a person meets after ignoring it read as one system.
    forkRemedy: `fork the session to use the ${other} engine.`,
  });
}

/** The one-line engine selection shown beside a conversation title. */
export function formatAgentRuntimeStatusLine(status: AgentRuntimeStatus): string {
  if (status.pinnedEngine === null) return `engine: ${status.defaultEngine} (default)`;
  return `engine: ${status.pinnedEngine} (recorded selection — fork the session to switch)`;
}
