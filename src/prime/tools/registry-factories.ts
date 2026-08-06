/**
 * createPrimeToolRegistry: the composition point for the prime tool
 * surface.
 *
 * What this module decides, and why:
 *   - Effect classes are honest ceilings, not conveniences. Workspace
 *     reads are "read"; file mutations are "write"; execute_code is
 *     "execute" because it runs model code and can reach every whitelisted
 *     tool through the reviewed bridge; rlm_spawn/subagent/agent_message
 *     are "execute" because they start and steer agent runs; the harness
 *     and heartbeat CRUD tools are "write" because they mutate durable
 *     state (a _read_ action on a CRUD tool still rides the same ceiling —
 *     airship effect classes are per-tool, never per-action, and a
 *     declared "read" tool that can delete state would be an approval
 *     bypass).
 *   - Missing ports mean missing tools, with the omission returned as
 *     data. A session without a kernel must not advertise execute_code;
 *     a session without an agent registry must not advertise rlm_spawn.
 *     The `omitted` list is the named absence the host surfaces in its
 *     capability inventory — optional labels never become phantom
 *     executable capabilities (the rule the live-environment layer keeps).
 *   - Registration order is deterministic regardless of argument
 *     evaluation order, because toolManifestDigest is pinned into session
 *     manifests and a shuffled digest forks sessions that should be
 *     identical.
 */

import type { ToolRegistry } from "../../tools/registry";
import { ToolRegistry as AirshipToolRegistry } from "../../tools/registry";
import type { WorkspacePort } from "../../workspace/contracts";
import type { PrimeKernelHost } from "../kernel/kernel-host";
import type { PrimeAgentRegistry } from "../subagents/registry";
import type { HarnessStore } from "../harness/store";
import { createPrimeReadFileTool, DEFAULT_PRIME_READ_BUDGETS, type PrimeReadFileBudgets } from "./read-file";
import { createPrimeEditFileTool, createPrimeWriteFileTool, DEFAULT_PRIME_WRITE_BUDGETS, type PrimeWriteFileBudgets } from "./write-file";
import {
  createPrimeListFilesTool,
  createPrimeSearchTextTool,
  DEFAULT_PRIME_SEARCH_BUDGETS,
  type PrimeSearchBudgets,
} from "./search-tools";
import { createPrimeExecuteCodeTool } from "./kernel-tool";
import {
  createPrimeAgentMessageTool,
  createPrimeAgentObserveTool,
  createPrimeHarnessTool,
  createPrimeRlmHeartbeatTool,
  createPrimeRlmSpawnTool,
  createPrimeSubagentTool,
  type PrimeHeartbeatStateStore,
  type PrimeRlmSelfIdentity,
} from "./rlm-tools";

/** Every tool this factory can register, in registration (deterministic) order, with the honest effect class. */
export const PRIME_TOOL_EFFECTS: Readonly<Record<string, "read" | "write" | "execute">> = Object.freeze({
  read_file: "read",
  list_files: "read",
  search_text: "read",
  write_file: "write",
  edit_file: "write",
  execute_code: "execute",
  rlm_spawn: "execute",
  subagent: "execute",
  agent_message: "execute",
  agent_observe: "read",
  rlm_heartbeat: "write",
  prime_harness: "write",
});

export type PrimeToolBudgets = Readonly<{
  read?: PrimeReadFileBudgets;
  write?: PrimeWriteFileBudgets;
  search?: PrimeSearchBudgets;
}>;

/** The agent-side wiring the RLM tools need: self identity plus the subagent orchestrator. */
export type PrimeToolAgentDeps = Readonly<{
  self: PrimeRlmSelfIdentity;
  registry: PrimeAgentRegistry;
}>;

export type PrimeToolRegistryDeps = Readonly<{
  workspace: WorkspacePort;
  /** Presence registers execute_code; absence omits it with a named reason. */
  kernel?: PrimeKernelHost;
  /** Presence registers rlm_spawn/subagent/agent_message/agent_observe; absence omits them with a named reason. */
  agent?: PrimeToolAgentDeps;
  /** Presence registers rlm_heartbeat; absence omits it with a named reason. */
  heartbeats?: PrimeHeartbeatStateStore;
  /** Presence registers prime_harness; absence omits it with a named reason. */
  harness?: HarnessStore;
  budgets?: PrimeToolBudgets;
  /** Label journaled with kernel jobs started via execute_code ("rlm", "tool"). */
  kernelJobLabel?: string;
}>;

export type PrimeToolRegistryResult = Readonly<{
  registry: ToolRegistry;
  /** Names registered, in registration order. */
  registered: readonly string[];
  /** Names withheld because their port was not wired, each with its named reason. */
  omitted: readonly Readonly<{ name: string; reason: string }>[];
}>;

export function createPrimeToolRegistry(deps: PrimeToolRegistryDeps): PrimeToolRegistryResult {
  const registry = new AirshipToolRegistry();
  const registered: string[] = [];
  const omitted: { name: string; reason: string }[] = [];
  const budgets = deps.budgets ?? {};

  registry.register(createPrimeReadFileTool(deps.workspace, budgets.read ?? DEFAULT_PRIME_READ_BUDGETS));
  registered.push("read_file");
  registry.register(createPrimeListFilesTool(deps.workspace));
  registered.push("list_files");
  registry.register(createPrimeSearchTextTool(deps.workspace, budgets.search ?? DEFAULT_PRIME_SEARCH_BUDGETS));
  registered.push("search_text");
  registry.register(createPrimeWriteFileTool(deps.workspace, budgets.write ?? DEFAULT_PRIME_WRITE_BUDGETS));
  registered.push("write_file");
  registry.register(createPrimeEditFileTool(deps.workspace));
  registered.push("edit_file");

  if (deps.kernel) {
    registry.register(createPrimeExecuteCodeTool(deps.kernel, deps.kernelJobLabel !== undefined ? { label: deps.kernelJobLabel } : {}));
    registered.push("execute_code");
  } else {
    omitted.push({ name: "execute_code", reason: "no prime kernel host is attached to this session" });
  }

  if (deps.agent) {
    registry.register(createPrimeRlmSpawnTool(deps.agent));
    registered.push("rlm_spawn");
    registry.register(createPrimeSubagentTool(deps.agent));
    registered.push("subagent");
    registry.register(createPrimeAgentMessageTool(deps.agent));
    registered.push("agent_message");
    registry.register(createPrimeAgentObserveTool(deps.agent));
    registered.push("agent_observe");
  } else {
    omitted.push(
      { name: "rlm_spawn", reason: "no agent registry is attached to this session" },
      { name: "subagent", reason: "no agent registry is attached to this session" },
      { name: "agent_message", reason: "no agent registry is attached to this session" },
      { name: "agent_observe", reason: "no agent registry is attached to this session" },
    );
  }

  if (deps.heartbeats) {
    registry.register(createPrimeRlmHeartbeatTool({ store: deps.heartbeats }));
    registered.push("rlm_heartbeat");
  } else {
    omitted.push({ name: "rlm_heartbeat", reason: "no chat-scoped state store is attached for heartbeats" });
  }

  if (deps.harness) {
    registry.register(createPrimeHarnessTool(deps.harness));
    registered.push("prime_harness");
  } else {
    omitted.push({ name: "prime_harness", reason: "no harness store is attached to this session" });
  }

  return Object.freeze({
    registry,
    registered: Object.freeze(registered),
    omitted: Object.freeze(omitted.map((entry) => Object.freeze(entry))),
  });
}
