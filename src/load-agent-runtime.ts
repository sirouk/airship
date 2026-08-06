import type { RunTurnOptions, TurnResult } from "./core/agent";
import type { PrimeRuntimeKind } from "./prime/runtime/runtime";
import type { EventJournal } from "./core/journal";

type AgentRuntime = typeof import("./core/agent");
type PrimeRuntimeModule = typeof import("./prime/runtime/runtime");

let agentRuntime: Promise<AgentRuntime> | undefined;
let primeRuntimePromise: Promise<PrimeRuntimeModule> | undefined;

export type AgentRuntimeKind = "airship-core" | "prime";
export type { PrimeRuntimeKind as PrimeRuntimeKindAlias } from "./prime/runtime/runtime";

/**
 * The evidence rule for which engine owns a session: presence of any
 * `prime.*` evidence pins the session prime; empty history (just the
 * creation record) is unclaimed land and primed by default. An engine flip
 * mid-history forks the evidence chain the same way a clock fork does,
 * so engines only run on the floors their journal has already seen.
 */
export function sessionRuntimeKind(events: readonly { type: string }[]): AgentRuntimeKind | "unpinned" {
  for (const event of events) {
    if (event.type.startsWith("prime.")) return "prime";
  }
  for (const event of events) {
    // turn-requested starts the airship-engine convention surface: the origin
    // of a journal populated only by airship turn protocol is airship-core.
    if (event.type.startsWith("turn.") || event.type.startsWith("inference.")) return "airship-core";
  }
  return "unpinned";
}

/**
 * The gate. `runtime` is an explicit caller override and is allowed only
 * against compatible journal evidence (fork semantics); omitted lets the
 * ordering work: prime by default for fresh sessions, evidence-preserving
 * for anything with history.
 */
export async function runTurn(options: RunTurnOptions & { runtime?: AgentRuntimeKind }): Promise<TurnResult> {
  const events = await options.journal.readEvents(options.sessionId);
  const history = sessionRuntimeKind(events);
  const selection: AgentRuntimeKind = options.runtime ?? (history === "unpinned" ? "prime" : history);

  if (options.runtime !== undefined) {
    if (options.runtime === "airship-core" && history === "prime") {
      throw new Error(`runtime selection mismatch: this session is prime-pinned by journal evidence; fork the session to use the airship-core runtime.`);
    }
    if (options.runtime === "prime" && history === "airship-core") {
      throw new Error(`runtime selection mismatch: this session runs airship-core; fork the session to use the prime runtime.`);
    }
  }

  if (selection === "prime") {
    primeRuntimePromise ??= import("./prime/runtime/runtime");
    return (await primeRuntimePromise).runPrimeTurn(options);
  }
  agentRuntime ??= import("./core/agent");
  return (await agentRuntime).runTurn(options);
}
