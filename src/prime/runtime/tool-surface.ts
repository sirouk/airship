import { ToolRegistry } from "../../tools/registry";
import type { ToolDefinition } from "../../core/contracts";
import type { WorkspacePort } from "../../workspace/contracts";
import type { HarnessStore } from "../harness/store";
import { createPrimeToolRegistry, type PrimeToolRegistryResult } from "../tools/registry-factories";
import { PrimeKernelHost } from "../kernel/kernel-host";
import { createPrimeExecuteCodeTool } from "../tools/kernel-tool";

/**
 * The tool surface a prime session runs on: prime's vocabulary, over Airship's
 * everything-else.
 *
 * Two vocabularies name the same five things — `read_file`, `list_files`,
 * `search_text`, `write_file`, `edit_file` — and both name `execute_code`.
 * `ToolRegistry.register` throws on a duplicate, so somebody has to lose, and
 * on a prime session it is Airship: the ported system prompt teaches prime's
 * call shapes by name, and a model told to call `read_file` with prime's
 * arguments against Airship's schema fails every time. Prime's `execute_code`
 * is the bigger difference — Airship's is a disposable executor with a fresh
 * interpreter per job, prime's is the persistent kernel `DETERMINATION.md`
 * measured at roughly eight times faster across a ten-job turn, which is the
 * reason the port exists at all.
 *
 * Everything Airship has that prime-agent does not — git, memory, tasks,
 * network, sessions, context retrieval, the execution-runtime family — is kept
 * verbatim. "Full prime" means prime's agent surface *plus* Airship's, not
 * prime's instead of it.
 *
 * The providers attached to the incoming registry (context runtime, turn
 * context, live environment, task plan) are carried across. They are not tools
 * and prime has no equivalent; dropping them would take the turn-context
 * contract and the live-environment snapshot down with them.
 */
export type PrimeToolSurface = Readonly<{
  registry: ToolRegistry;
  /** Prime tool names that displaced an Airship tool of the same name. */
  displaced: readonly string[];
  /** Prime tools withheld because their port is not wired, with the reason. */
  omitted: readonly Readonly<{ name: string; reason: string }>[];
}>;

export type PrimeToolSurfaceInput = Readonly<{
  /** The Profile-scoped workspace port; prime's file tools are built over it. */
  workspace: WorkspacePort;
  /** Airship's registry, whose non-colliding tools and providers are carried over. */
  airship: ToolRegistry;
  /** Present once the device harness store is available; absence omits `prime_harness`. */
  harness?: HarnessStore;
}>;

/**
 * Compose the surface. Deliberately does not take the kernel: the kernel host
 * belongs to a session that does not exist yet when the manifest has to be
 * digested, so `execute_code` is registered against the live host afterwards
 * by `attachPrimeKernelTool`. The *definition* is stable either way, which is
 * what `toolManifestDigest` binds.
 */
export function createPrimeToolSurface(input: PrimeToolSurfaceInput): PrimeToolSurface {
  const prime: PrimeToolRegistryResult = createPrimeToolRegistry({
    workspace: input.workspace,
    ...(input.harness ? { harness: input.harness } : {}),
  });

  const merged = new ToolRegistry();
  const displaced: string[] = [];

  // Prime first, so its names are already taken when Airship's are offered.
  for (const definition of prime.registry.definitions()) {
    const tool = prime.registry.get(definition.name);
    if (tool) merged.register(tool);
  }
  for (const definition of input.airship.definitions()) {
    const tool = input.airship.get(definition.name);
    if (!tool) continue;
    if (merged.get(definition.name)) {
      displaced.push(definition.name);
      continue;
    }
    merged.register(tool);
  }

  carryProviders(input.airship, merged);

  return Object.freeze({
    registry: merged,
    displaced: Object.freeze(displaced),
    omitted: prime.omitted,
  });
}

/**
 * Bind `execute_code` to the session's own kernel host.
 *
 * Separate from composition because of an ordering the manifest forces: the
 * digest is taken from tool *definitions* before a session exists, while the
 * kernel host is session-scoped and boots lazily on first use. So the
 * definition is pinned up front by `primeToolDefinitions`, and the executable
 * is attached here once the session — and therefore the host its bridge is
 * wired to — is real. Registering against any other host would break the
 * `prime-kernel:<jobId>:<seq>` operation identity the approval bridge journals
 * under.
 */
export function attachPrimeKernelTool(registry: ToolRegistry, kernelHost: PrimeKernelHost): void {
  const tool = createPrimeExecuteCodeTool(kernelHost);
  if (registry.get(tool.definition.name)) return;
  registry.register(tool);
}

/**
 * The definitions a prime session's manifest pins, including `execute_code`.
 *
 * Built from a kernel host that is constructed and never started — the pattern
 * `session.test.ts` uses — because a definition is a shape, not a capability,
 * and the shape may not wait for a worker to boot. Nothing here can start a
 * kernel: `PrimeKernelHost` boots only inside `exec()`.
 */
export function primeToolDefinitions(input: PrimeToolSurfaceInput): readonly ToolDefinition[] {
  const surface = createPrimeToolSurface(input);
  const probe = new PrimeKernelHost({
    ports: { bridge: { call: () => Promise.reject(new Error("definition probe host is never executed")) } },
  });
  const executeCode = createPrimeExecuteCodeTool(probe);
  if (!surface.registry.get(executeCode.definition.name)) surface.registry.register(executeCode);
  return surface.registry.definitions();
}

/** Providers are registry state, not tools; the merge has to carry them. */
function carryProviders(from: ToolRegistry, to: ToolRegistry): void {
  const contextRuntime = from.getContextRuntime();
  if (contextRuntime) to.attachContextRuntime(contextRuntime);
  const turnContext = from.getTurnContextProvider();
  if (turnContext) to.attachTurnContextProvider(turnContext);
  const liveEnvironment = from.getLiveEnvironmentProvider();
  if (liveEnvironment) to.attachLiveEnvironmentProvider(liveEnvironment);
  const taskPlan = from.getTaskPlanProvider();
  if (taskPlan) to.attachTaskPlanProvider(taskPlan);
}
