import type { RunTurnOptions, TurnResult } from "./core/agent";
import type { PrimeRuntimeKind } from "./prime/runtime/runtime";

type AgentRuntime = typeof import("./core/agent");
type PrimeRuntimeModule = typeof import("./prime/runtime/runtime");

let agentRuntime: Promise<AgentRuntime> | undefined;
let primeRuntimePromise: Promise<PrimeRuntimeModule> | undefined;

/** Load the complete inspect-act-verify loop only when a person sends a turn. */
export async function runTurn(options: RunTurnOptions & { runtime?: PrimeRuntimeKind }): Promise<TurnResult> {
  if (options.runtime === "prime") {
    primeRuntimePromise ??= import("./prime/runtime/runtime");
    return (await primeRuntimePromise).runPrimeTurn(options);
  }
  agentRuntime ??= import("./core/agent");
  return (await agentRuntime).runTurn(options);
}
