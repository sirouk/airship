import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../tools/registry";
import type { Tool } from "../../core/contracts";
import { FakeWorkspacePort } from "../tools/test-utils.test-support";
import { createPrimeToolSurface, primeToolDefinitions } from "./tool-surface";

/**
 * "Full prime" means prime's agent surface plus Airship's, and the collision
 * is the whole difficulty: both vocabularies name `read_file`, `list_files`,
 * `search_text`, `write_file`, `edit_file` and `execute_code`, and
 * `ToolRegistry.register` throws on a duplicate. Somebody has to lose, and on
 * a prime session it has to be Airship — the ported system prompt teaches
 * prime's call shapes by name, so a model calling `read_file` with prime's
 * arguments against Airship's schema fails every time.
 */
function airshipRegistry(names: readonly string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) registry.register(stubTool(name));
  return registry;
}

function stubTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `airship ${name}`,
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      return { content: `airship ${name}` };
    },
  };
}

describe("the prime tool surface", () => {
  it("lets prime's vocabulary win the names both engines claim", () => {
    const surface = createPrimeToolSurface({
      workspace: new FakeWorkspacePort({}),
      airship: airshipRegistry(["read_file", "list_files", "search_text", "git_inspect"]),
    });

    expect([...surface.displaced].sort()).toEqual(["list_files", "read_file", "search_text"]);
    // The winning tools are prime's, not Airship's stubs.
    for (const name of ["read_file", "list_files", "search_text"]) {
      expect(surface.registry.get(name)?.definition.description).not.toContain("airship");
    }
  });

  it("keeps every Airship tool prime has no answer for", () => {
    // Prime-agent has no git, memory, task or session tools; "full prime" is
    // additive, and a port that silently removed them would be a downgrade
    // wearing an upgrade's name.
    const surface = createPrimeToolSurface({
      workspace: new FakeWorkspacePort({}),
      airship: airshipRegistry(["read_file", "git_inspect", "recall_memory", "list_tasks", "search_sessions"]),
    });

    const names = surface.registry.definitions().map((definition) => definition.name);
    for (const kept of ["git_inspect", "recall_memory", "list_tasks", "search_sessions"]) {
      expect(names, `${kept} must survive the merge`).toContain(kept);
    }
    expect(surface.displaced).toEqual(["read_file"]);
  });

  it("carries the providers across, which are registry state and not tools", () => {
    // Drop these and the turn-context contract and the live-environment
    // snapshot go with them — neither has a prime equivalent to replace it.
    const airship = airshipRegistry([]);
    const turnContext = { async provide() { return undefined; } } as never;
    const liveEnvironment = { async snapshot() { return undefined; } } as never;
    airship.attachTurnContextProvider(turnContext);
    airship.attachLiveEnvironmentProvider(liveEnvironment);

    const surface = createPrimeToolSurface({ workspace: new FakeWorkspacePort({}), airship });

    expect(surface.registry.getTurnContextProvider()).toBe(turnContext);
    expect(surface.registry.getLiveEnvironmentProvider()).toBe(liveEnvironment);
  });

  it("registers every name whether or not its port is bound yet", () => {
    // The rule changed on purpose. Omitting a tool whose port is missing is
    // right for a capability inventory and wrong for a manifest: the digest
    // binds names, and a surface whose names depend on which ports happened to
    // be constructible cannot match the same conversation twice. Deferred is
    // not phantom — an unbound port refuses by name when called.
    const surface = createPrimeToolSurface({
      workspace: new FakeWorkspacePort({}),
      airship: airshipRegistry([]),
    });

    const names = surface.registry.definitions().map((definition) => definition.name);
    for (const tool of ["rlm_spawn", "subagent", "agent_message", "prime_harness", "execute_code"]) {
      expect(names, `${tool} must be registered`).toContain(tool);
    }
    expect(surface.omitted).toEqual([]);
  });

  it("registers the whole RLM family once an agent registry and heartbeat store exist", () => {
    // The four names that were omitted from every session with "no agent
    // registry is attached to this session", because the only implementation
    // of `PrimeAgentRuntimeFactory` was a test double. A production factory
    // exists now, so absence has to stop being the answer.
    const surface = createPrimeToolSurface({
      workspace: new FakeWorkspacePort({}),
      airship: airshipRegistry([]),
      agent: { self: { id: "root", name: "root", depth: 0 }, registry: {} as never },
      heartbeats: { read: () => undefined, write: () => undefined },
    });

    const names = surface.registry.definitions().map((definition) => definition.name);
    for (const tool of ["rlm_spawn", "subagent", "agent_message", "agent_observe", "rlm_heartbeat"]) {
      expect(names, `${tool} must be registered`).toContain(tool);
    }
    expect(surface.omitted.map((entry) => entry.name)).not.toContain("rlm_spawn");
  });

  it("pins execute_code in the manifest definitions without booting a kernel", async () => {
    // `toolManifestDigest` is taken before a session — and therefore before a
    // kernel host — exists, so the definition has to come from a probe host
    // that is constructed and never started. If this ever boots a worker, it
    // will boot one per session creation.
    const definitions = primeToolDefinitions({
      workspace: new FakeWorkspacePort({}),
      airship: airshipRegistry(["git_inspect"]),
    });

    const names = definitions.map((definition) => definition.name);
    expect(names).toContain("execute_code");
    expect(names).toContain("read_file");
    expect(names).toContain("git_inspect");
  });
});

/*
 * The regression this pair exists to stop repeating.
 *
 * `toolManifestDigest` is immutable and the session refuses any registry that
 * does not match it. Composing a richer surface at turn time without pinning
 * it at session creation is exactly that refusal — and it failed *every* turn
 * on *every* conversation with "The tool manifest changed. Fork the session
 * before using a different tool set." A turn that reaches for a capability the
 * manifest never pinned must degrade to what was pinned, never fail.
 */
describe("the surface and the manifest have to agree", () => {
  it("digests identically to what a manifest pinned from the same inputs", async () => {
    const { sha256, stableStringify } = await import("../../core/hash");
    const workspace = new FakeWorkspacePort({});
    const airship = airshipRegistry(["git_inspect"]);

    // What `app.tsx` pins at session creation…
    const pinned = primeToolDefinitions({ workspace, airship });
    // …and what `runPrimeTurn` composes on every later turn. They must agree
    // whatever ports were constructible, which is why every port is deferred
    // rather than omitted: the manifest binds names.
    const surface = createPrimeToolSurface({ workspace, airship });

    const pinnedDigest = await sha256(stableStringify(pinned as never));
    const turnDigest = await sha256(stableStringify(surface.registry.definitions() as never));
    expect(turnDigest).toBe(pinnedDigest);
  });

  it("composes a surface whose omissions do not change its digest identity", () => {
    // Two turns of the same conversation must digest the same even though the
    // agent registry is rebuilt per turn: the *names* are what the manifest
    // binds, and they are stable for a given set of ports.
    const workspace = new FakeWorkspacePort({});
    const airship = airshipRegistry(["git_inspect"]);
    const first = createPrimeToolSurface({ workspace, airship }).registry.definitions();
    const second = createPrimeToolSurface({ workspace, airship }).registry.definitions();
    expect(second.map((d) => d.name)).toEqual(first.map((d) => d.name));
  });
});
