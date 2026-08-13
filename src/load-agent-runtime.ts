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
 * journal decide: prime for a fresh session, evidence-preserving for anything
 * with history.
 *
 * PRIME IS THE DEFAULT ENGINE. Every unpinned journal — which is every
 * conversation the app has not yet run a turn in — opens on prime, and the
 * first prime turn seals that decision into the journal so the choice is
 * durable evidence rather than a runtime mood. airship-core keeps every
 * session whose journal already carries airship turn protocol; those only
 * change engines by forking, because an engine flip mid-history forks the
 * evidence chain the same way a clock fork does.
 *
 * What made this reachable: `runPrimeTurn` now forwards the caller's
 * transport (see the credential-bridge note there), so the prime lane runs a
 * vendor provider over the caller's own wire instead of asking the ported
 * registry for a key it was never given. That was the single reason this
 * branch used to send every transport-carrying session to airship-core, and
 * with it gone the transport is no longer part of the selection at all — it
 * had never been a fact about which engine *should* run, only about which one
 * *could*.
 *
 * The demo transport goes with it, deliberately. Its carve-out existed for
 * exactly the same missing bridge ("a prime-session lane asking for an
 * airship-demo API key"), and `airship-demo` is an `InferenceTransport` like
 * any other: the adapter bridges it, and its Profile pins `providerId:
 * "airship-demo"`, so the session's provider check matches the way a vendor
 * session's does. A first-run visitor gets the engine the product is built
 * on, not a second one kept alive for the unconnected case.
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
