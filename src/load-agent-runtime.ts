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
  /*
   * The demo transport is the airship-core lane by construction: it exists
   * exactly while nothing is connected, pinned to `airship-demo` in every
   * built-in Profile, and nothing about prime provider resolution can take
   * it — a prime-session lane asking for an airship-demo API key is the
   * default-on wave's crash of the demo default. Inference for the demo
   * runs where it always did; only the lane ownership is decided here, not
   * the engine's evidence, and real inference ignores this branch entirely.
   */
  if (options.transport?.id === "airship-demo") {
    agentRuntime ??= import("./core/agent");
    return (await agentRuntime).runTurn(options);
  }
  /*
   * Every vendor transport the product carries (Chutes, anthropic, openai,
   * ollama, lm-studio) reaches this gate with its own credential plumbing
   * already bound. The prime lane asks the provider itself to resolve a key
   * from a vault = it has never been told about, so a fresh conversation's
   * first real-provider turn currently dies inside runPrimeTurn with "No API
   * key for provider: <id>". Until runPrimeTurn is taught to forward both
   * the vendor stream and its key getter, fresh unpinned sessions take the
   * lane the merge built them on: airship-core runs every vendor transport
   * directly, the way it always did. Prime remains the lane of every
   * prime-pinned journal and every explicit runtime request; the engine is
   * central, and this is the move that protects it from being blamed for a
   * missing credential bridge.
   */
  const events = await options.journal.readEvents(options.sessionId);
  const history = sessionRuntimeKind(events);
  const selection: AgentRuntimeKind = options.runtime ?? (history === "unpinned"
    ? options.transport !== undefined ? "airship-core" : "prime"
    : history);

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
