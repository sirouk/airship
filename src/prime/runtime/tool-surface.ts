import { ToolRegistry } from "../../tools/registry";
import type { ToolDefinition } from "../../core/contracts";
import type { WorkspacePort } from "../../workspace/contracts";
import type { HarnessStore } from "../harness/store";
import { createPrimeToolRegistry, type PrimeToolAgentDeps, type PrimeToolRegistryResult } from "../tools/registry-factories";
import type { PrimeHeartbeatStateStore } from "../tools/rlm-tools";
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
 * is job-scoped: JavaScript runs in a fresh strict worker. The historically
 * faster persistent-Pyodide prototype is quarantined because cross-cell task
 * provenance cannot be proven, so no production tool can activate it.
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
  /** Filled in by `attachPrimeKernelTool` once the session's host exists. */
  kernel: { bind(host: PrimeKernelHost): void };
  /** Filled in by `attachPrimeAgentRegistry` once a transport-backed one exists. */
  agents: { bind(registry: unknown, self: unknown): void };
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
  /** Present once a runtime factory exists; absence omits the whole RLM family. */
  agent?: PrimeToolAgentDeps;
  /** Present once a synchronous-read heartbeat store exists; absence omits `rlm_heartbeat`. */
  heartbeats?: PrimeHeartbeatStateStore;
}>;

/**
 * Compose the surface.
 *
 * `execute_code` is always registered, and always with the same definition,
 * because `toolManifestDigest` binds definitions and a surface that sometimes
 * carries the tool and sometimes does not can never match a manifest twice.
 * The *executable* is what varies: the kernel host is session-scoped and does
 * not exist while the manifest is being digested, so the tool is built over a
 * holder that `attachPrimeKernelTool` fills in once the session is real.
 *
 * This replaced a probe-host-then-re-register arrangement that could not work.
 * The digest was taken from a surface without `execute_code` and compared to a
 * manifest that pinned it, so it mismatched every time, fell back to Airship's
 * registry, and then failed that comparison too — every turn of every
 * conversation, before a single inference event.
 */
export function createPrimeToolSurface(input: PrimeToolSurfaceInput): PrimeToolSurface {
  /*
   * Every port is always supplied, and the ones the caller did not bring are
   * deferred rather than absent.
   *
   * `createPrimeToolRegistry` omits a tool whose port is missing, which is the
   * right rule for a capability inventory and the wrong one for a manifest:
   * `toolManifestDigest` binds *names*, and a surface whose names depend on
   * which ports happened to be constructible cannot match the same
   * conversation twice. The manifest was pinned without an agent registry —
   * there is no transport at session creation — while the turn composed one,
   * so the digests differed by four names and every turn was refused.
   *
   * Deferred is not phantom. An unbound port refuses by name when called, so
   * the failure is "the agent registry is not attached to this session yet"
   * rather than a tool that silently pretends to work.
   */
  const kernel = new DeferredKernelHost();
  const agents = new DeferredAgentRegistry();
  const prime: PrimeToolRegistryResult = createPrimeToolRegistry({
    workspace: input.workspace,
    harness: input.harness ?? deferredHarness(),
    agent: input.agent ?? { self: DEFERRED_SELF, registry: agents as never },
    heartbeats: input.heartbeats ?? DEFERRED_HEARTBEATS,
  });

  const merged = new ToolRegistry();
  const displaced: string[] = [];

  // Prime first, so its names are already taken when Airship's are offered.
  for (const definition of prime.registry.definitions()) {
    const tool = prime.registry.get(definition.name);
    if (tool) merged.register(tool);
  }
  merged.register(createPrimeExecuteCodeTool(kernel as unknown as PrimeKernelHost));
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
    kernel,
    agents,
    displaced: Object.freeze(displaced),
    // Nothing is omitted any more: every name is registered, and the ones
    // without a live port say so when called.
    omitted: Object.freeze([] as readonly Readonly<{ name: string; reason: string }>[]),
  });
}

/**
 * Point the surface's `execute_code` at the session's own kernel host.
 *
 * Binding rather than registering, because registering a second tool of the
 * same name throws and re-registering would change nothing the manifest can
 * see. The identity matters: a job dispatched to any other host would journal
 * its bridge calls under a `prime-kernel:<jobId>:<seq>` operation identity no
 * approval on this session matches.
 */
export function attachPrimeKernelTool(surface: PrimeToolSurface, host: PrimeKernelHost): void {
  surface.kernel.bind(host);
}

/** The definitions a prime session's manifest pins. */
export function primeToolDefinitions(input: PrimeToolSurfaceInput): readonly ToolDefinition[] {
  return createPrimeToolSurface(input).registry.definitions();
}

/**
 * Stands in for the kernel host until the session that owns one exists.
 *
 * Only the two methods `createPrimeExecuteCodeTool` calls are forwarded. An
 * unbound call is a descriptive refusal rather than a crash: it means a turn
 * reached `execute_code` before its session was attached, which is a wiring
 * fault worth naming rather than a `TypeError` about undefined.
 */
class DeferredKernelHost {
  #host: PrimeKernelHost | undefined;

  bind(host: PrimeKernelHost): void {
    this.#host = host;
  }

  exec(...args: Parameters<PrimeKernelHost["exec"]>): ReturnType<PrimeKernelHost["exec"]> {
    return this.#require().exec(...args);
  }

  cancel(...args: Parameters<PrimeKernelHost["cancel"]>): ReturnType<PrimeKernelHost["cancel"]> {
    return this.#require().cancel(...args);
  }

  #require(): PrimeKernelHost {
    if (!this.#host) {
      throw new Error("The prime kernel is not attached to this session yet, so execute_code cannot run.");
    }
    return this.#host;
  }
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

/** The identity a deferred family reports until a real one is bound. */
const DEFERRED_SELF = Object.freeze({ id: "unbound", name: "unbound", depth: 0 });

/** No heartbeat state until a store is bound; reads are empty, writes refuse. */
const DEFERRED_HEARTBEATS = Object.freeze({
  read: () => undefined,
  write: () => {
    throw new Error("No heartbeat store is attached to this session, so rlm_heartbeat cannot record state.");
  },
});

function deferredHarness(): never {
  // Typed as the store the factory wants; every method refuses by name.
  const refuse = () => {
    throw new Error("No harness store is attached to this session, so prime_harness cannot be used.");
  };
  return new Proxy({}, { get: () => refuse }) as never;
}

/**
 * Stands in for the subagent registry until a transport-backed one exists.
 *
 * The RLM tools reach it through a handful of methods; forwarding them all
 * through one holder keeps the tool *definitions* — and therefore the manifest
 * digest — identical whether or not a registry is bound yet.
 */
class DeferredAgentRegistry {
  #registry: unknown;
  #self: unknown;

  bind(registry: unknown, self: unknown): void {
    this.#registry = registry;
    this.#self = self;
  }

  get self(): unknown {
    return this.#self ?? DEFERRED_SELF;
  }

  #require(): Record<string, (...args: unknown[]) => unknown> {
    if (!this.#registry) {
      throw new Error("No agent registry is attached to this session, so subagents cannot be started or messaged.");
    }
    return this.#registry as Record<string, (...args: unknown[]) => unknown>;
  }

  spawn(...args: unknown[]): unknown { return this.#require().spawn(...args); }
  stop(...args: unknown[]): unknown { return this.#require().stop(...args); }
  list(...args: unknown[]): unknown { return this.#require().list(...args); }
  get route(): unknown { return (this.#require() as { route: unknown }).route; }
  setRlmMaxDepth(...args: unknown[]): unknown { return this.#require().setRlmMaxDepth(...args); }
  attachNode(...args: unknown[]): unknown { return this.#require().attachNode(...args); }
  reachableAgents(...args: unknown[]): unknown { return this.#require().reachableAgents(...args); }
  recentMessages(...args: unknown[]): unknown { return this.#require().recentMessages(...args); }
  sendMessage(...args: unknown[]): unknown { return this.#require().sendMessage(...args); }
}

/** Point the surface's RLM family at a transport-backed registry. */
export function attachPrimeAgentRegistry(surface: PrimeToolSurface, registry: unknown, self: unknown): void {
  surface.agents.bind(registry, self);
}
