import type { RunTurnOptions, TurnResult } from "./core/agent";

type AgentRuntime = typeof import("./core/agent");

let agentRuntime: Promise<AgentRuntime> | undefined;

/** Load the complete inspect-act-verify loop only when a person sends a turn. */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  agentRuntime ??= import("./core/agent");
  return (await agentRuntime).runTurn(options);
}
