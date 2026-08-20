import { describe, expect, it } from "vitest";
import type { PrimeHarnessEntry, PrimeHarnessScope } from "../runtime/types-prime";
import { PrimeAgentRegistry } from "./registry";
import {
  MAX_AGENT_NAME_CHARS,
  type PrimeAgentRegistryDeps,
  type PrimeHarnessStore,
  type PrimeSubagentSpawnOptions,
} from "./types";
import { createFakeFactory, createFakeIds, createOwner, flush } from "./test-utils.test-support";

/**
 * Admission is the contract's crown jewel: spawn returns with a handle and
 * never with the answer (manifest invariant 25). These tests pin down the
 * handle shape, the busy-wait prohibition, the kwargs rule, name validation
 * and sibling-global uniqueness (freeze consolidation), the pending-name
 * race, the default-name derivation, and the max-depth precedence ladder.
 */

function deps(overrides: Partial<PrimeAgentRegistryDeps> = {}): PrimeAgentRegistryDeps {
  const factory = createFakeFactory({ default: { text: "ack" } });
  const owner = createOwner();
  return {
    factory: factory.factory,
    owner: owner.node,
    randomId: createFakeIds(),
    ...overrides,
  };
}

describe("PrimeAgentRegistry admission", () => {
  it("returns the handle at admission and never waits for the factory's answer", async () => {
    const factory = createFakeFactory();
    const gate = factory.deferNextCreate();
    const owner = createOwner();
    const registry = new PrimeAgentRegistry({
      factory: factory.factory,
      owner: owner.node,
      randomId: createFakeIds(),
    });

    // The factory promise stays unresolved the whole time; spawn must still resolve.
    const handle = await registry.spawn("Summarize the release notes");
    expect(factory.created).toHaveLength(1);
    expect(handle.id).toMatch(/^sub-[0-9a-f]{8}$/);
    expect(handle.role).toBe("subagent");
    expect(handle.parentId).toBe("owner");
    expect(handle.depth).toBe(1);
    expect(handle.name).toMatch(/^subagent-summarize-the-release-notes-[0-9a-f]{8}$/);
    expect(handle.status).toBe("running");
    expect(handle.model).toBe(owner.node.model);
    expect(handle.sessionPath).toBe(`${owner.node.sessionPath}/${handle.id}`);
    // The factory received the wrapped task and the spawn:<childId> envelope.
    expect(factory.created[0]?.taskPrompt).toBe("[task from parent]\n\nSummarize the release notes");
    expect(factory.created[0]?.spawnMessage.id).toBe(`spawn:${handle.id}`);

    // Belatedly materialize the bundle: the detached task picks it up and
    // the scripted child runs to completion without spawn ever having waited.
    gate.resolve(factory.buildBundle(factory.created[0] as Parameters<typeof factory.buildBundle>[0]));
    await flush();
    expect(registry.list()[0]?.status).toBe("idle");
  });

  it("emits subagent-admitted before the runtime factory settles", async () => {
    const factory = createFakeFactory();
    factory.deferNextCreate();
    const owner = createOwner();
    const registry = new PrimeAgentRegistry({ factory: factory.factory, owner: owner.node, randomId: createFakeIds() });
    const seen: string[] = [];
    registry.onEvent((event) => seen.push(event.type));
    await registry.spawn("check the logs");
    expect(seen[0]).toBe("subagent-admitted");
  });

  it("rejects unsupported kwargs with a descriptive TypeError", async () => {
    const registry = new PrimeAgentRegistry(deps());
    await expect(registry.spawn("do work", { watch: true } as unknown as PrimeSubagentSpawnOptions)).rejects.toThrow(
      TypeError,
    );
    await expect(
      registry.spawn("do work", { zeta: 1, alpha: 2 } as unknown as PrimeSubagentSpawnOptions),
    ).rejects.toThrow("Unsupported rlm.run kwargs: alpha, zeta");
  });

  it("rejects empty and oversized prompts", async () => {
    const registry = new PrimeAgentRegistry(deps());
    await expect(registry.spawn("   ")).rejects.toThrow("rlm.run prompt must be a non-empty string");
    const oversized = "x".repeat(16 * 1024 + 1);
    await expect(registry.spawn(oversized)).rejects.toThrow(/rlm.run prompt is too long: .* exceeds 16384/);
  });

  it("validates names: empty, oversized, charset", async () => {
    const registry = new PrimeAgentRegistry(deps());
    await expect(registry.spawn("p", { name: " " })).rejects.toThrow("rlm.run name must not be empty");
    await expect(registry.spawn("p", { name: "a".repeat(MAX_AGENT_NAME_CHARS + 1) })).rejects.toThrow(
      `rlm.run name must be at most ${MAX_AGENT_NAME_CHARS} characters`,
    );
    await expect(registry.spawn("p", { name: "bad name!" })).rejects.toThrow(/unsupported characters/);
    await expect(registry.spawn("p", { name: "-leading-hyphen" })).rejects.toThrow(/unsupported characters/);
    await expect(registry.spawn("p", { name: "ok.name_2-C" })).resolves.toBeTruthy();
    await flush();
  });

  it("enforces name uniqueness globally among siblings, including against pending admissions", async () => {
    const factory = createFakeFactory({ default: { text: "ack" } });
    factory.deferNextCreate();
    const owner = createOwner();
    const registry = new PrimeAgentRegistry({
      factory: factory.factory,
      owner: owner.node,
      randomId: createFakeIds(),
      // Slow resolver makes the race window real: both spawns reach the
      // awaited section before either finishes.
      modelResolver: (_requested, inherited) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(inherited), 0);
        }),
    });
    const first = registry.spawn("task one", { name: "racer" });
    const second = registry.spawn("task two", { name: "racer" });
    const settled = await Promise.allSettled([first, second]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      'Agent name "racer" is unavailable',
    );

    // Catalog uniqueness, sibling-GLOBAL (freeze consolidation): an attached
    // node at a different depth under a different parent still blocks the name.
    registry.attachNode(createOwner({ id: "other", name: "cousin", depth: 2, parentId: "elsewhere" }).node);
    await expect(registry.spawn("p", { name: "cousin" })).rejects.toThrow(/unavailable/);

    // A completed child's name stays taken until the child is reaped.
    const done = await registry.spawn("quick task");
    await flush();
    await expect(registry.spawn("p", { name: done.name })).rejects.toThrow(/unavailable/);
  });

  it("derives default names from a prompt slug capped at 40 chars", async () => {
    const registry = new PrimeAgentRegistry(deps());
    const shorty = await registry.spawn("Fix the flaky login test");
    expect(shorty.name).toMatch(/^subagent-fix-the-flaky-login-test-[0-9a-f]{8}$/);
    const long = await registry.spawn(
      "This is an extremely long prompt whose slug would otherwise exceed forty characters of budget",
    );
    // subagent- (9) + <=40 slug + - (1) + 8 hex <= 58
    expect(long.name.length).toBeLessThanOrEqual(58);
    expect(long.name.startsWith("subagent-this-is-an-extremely-long-prompt-wh")).toBe(true);
    await flush();
  });

  it("gates recursion depth with the upstream error text", async () => {
    const registry = new PrimeAgentRegistry(deps());
    // Default max depth 1: a depth-0 root can spawn; depth 1 cannot.
    await expect(registry.spawn("allowed at depth 0")).resolves.toBeTruthy();
    await expect(registry.spawn("blocked", { depth: 1 })).rejects.toThrow(
      "RLM recursion depth limit reached (RLM_DEPTH=1, RLM_MAX_DEPTH=1)",
    );
    await flush();
  });

  it("applies max-depth precedence chat > global > env > default", async () => {
    {
      const registry = new PrimeAgentRegistry(deps({ env: { RLM_MAX_DEPTH: "3" } }));
      await expect(registry.spawn("p", { depth: 2 })).resolves.toBeTruthy();
      await expect(registry.spawn("p", { depth: 3 })).rejects.toThrow(/RLM_MAX_DEPTH=3/);
      expect(await registry.getMaxDepthStatus()).toEqual({ maxDepth: 3, source: "env" });
    }
    {
      const registry = new PrimeAgentRegistry(deps({ env: { RLM_MAX_DEPTH: "4" }, globalMaxDepth: 2 }));
      expect(await registry.getMaxDepthStatus()).toEqual({ maxDepth: 2, source: "global" });
      await expect(registry.spawn("p", { depth: 2 })).rejects.toThrow(/RLM_MAX_DEPTH=2/);
    }
    {
      const registry = new PrimeAgentRegistry(deps({ env: { RLM_MAX_DEPTH: "soon" } }));
      await expect(registry.spawn("p")).rejects.toThrow("RLM_MAX_DEPTH must be a non-negative integer");
    }
    {
      const registry = new PrimeAgentRegistry(deps());
      expect(await registry.getMaxDepthStatus()).toEqual({ maxDepth: 1, source: "default" });
    }
    await flush();
  });

  it("persists setRlmMaxDepth to the harness store under the reserved subagent entry", async () => {
    const entries = new Map<string, PrimeHarnessEntry>();
    const keyOf = (scope: PrimeHarnessScope, kind: string | undefined, id: string) => `${scope}:${kind}:${id}`;
    const store: PrimeHarnessStore = {
      list: async () => [...entries.values()],
      get: async (scope, kind, id) => entries.get(keyOf(scope, kind, id)),
      create: async (scope, input) => {
        const materialized = {
          ...input,
          id: input.id ?? `entry:${entries.size}`,
          scope,
          source: "agent" as const,
          createdAt: 0,
          updatedAt: 0,
          version: 1,
        } as PrimeHarnessEntry;
        entries.set(keyOf(scope, materialized.kind, materialized.id), materialized);
        return materialized;
      },
      update: async (scope, kind, id, patch, options) => {
        const key = keyOf(scope, kind, id);
        const existing = entries.get(key);
        if (!existing || (options?.expectedVersion !== undefined && existing.version !== options.expectedVersion)) {
          throw new Error(`harness concurrency conflict on ${key}`);
        }
        const next = { ...existing, ...patch, version: existing.version + 1, updatedAt: 0 } as PrimeHarnessEntry;
        entries.set(key, next);
        return next;
      },
      delete: async (scope, kind, id) => {
        const key = keyOf(scope, kind, id);
        if (!entries.has(key)) return false;
        entries.delete(key);
        return true;
      },
      refinements: async () => [],
      getRefinement: async () => undefined,
      applyRefinement: async () => Promise.reject(new Error("not implemented in test double")),
      rollback: async () => Promise.reject(new Error("not implemented in test double")),
      snapshot: async () => ({ schema: 1, entries: [...entries.values()], refinements: [] }),
      restore: async () => undefined,
      snapshotId: async () => "s",
    };
    const registry = new PrimeAgentRegistry(
      deps({ harnessStore: store, env: { RLM_MAX_DEPTH: "1" }, globalMaxDepth: 2 }),
    );
    await registry.setRlmMaxDepth(5);
    const persisted = entries.get("local:subagent:subagent:max-depth");
    expect(persisted?.kind).toBe("subagent");
    expect(persisted?.scope).toBe("local");
    expect(persisted?.metadata).toEqual({ maxDepth: 5 });
    expect(await registry.getMaxDepthStatus()).toEqual({ maxDepth: 5, source: "chat" });
    await expect(registry.spawn("p", { depth: 4 })).resolves.toBeTruthy();
    await expect(registry.spawn("p", { depth: 5 })).rejects.toThrow(/RLM_MAX_DEPTH=5/);

    // A fresh registry over the same store picks the chat override up.
    const second = new PrimeAgentRegistry(deps({ harnessStore: store, env: { RLM_MAX_DEPTH: "1" }, globalMaxDepth: 2 }));
    expect(await second.getMaxDepthStatus()).toEqual({ maxDepth: 5, source: "chat" });

    await expect(registry.setRlmMaxDepth(1.5)).rejects.toThrow("RLM max depth must be a non-negative integer.");
    await expect(registry.setRlmMaxDepth(-1)).rejects.toThrow("RLM max depth must be a non-negative integer.");
    await flush();
  });

  it("treats a corrupt persisted max-depth entry as absent and falls through the ladder", async () => {
    const store: Partial<PrimeHarnessStore> = {
      get: async () => ({ kind: "subagent", content: "not-a-number" }) as unknown as PrimeHarnessEntry,
    };
    const registry = new PrimeAgentRegistry(
      deps({ harnessStore: store as PrimeHarnessStore, env: { RLM_MAX_DEPTH: "2" } }),
    );
    expect(await registry.getMaxDepthStatus()).toEqual({ maxDepth: 2, source: "env" });
  });

  it("resolves models through the injected catalog and fails closed without one", async () => {
    const owner = createOwner();
    const factory = createFakeFactory({ default: { text: "ack" } });
    const registry = new PrimeAgentRegistry({
      factory: factory.factory,
      owner: owner.node,
      randomId: createFakeIds(),
      modelResolver: (requested, inherited) => {
        if (requested === undefined) return inherited;
        if (requested === "openai/mock") return inherited;
        throw new Error(`model selector "${requested}" is not in the authenticated catalog`);
      },
    });
    const inherited = await registry.spawn("p");
    expect(inherited.model).toBe(owner.node.model);
    await expect(registry.spawn("p", { model: "unknown/provider" })).rejects.toThrow(/not in the authenticated catalog/);

    const closed = new PrimeAgentRegistry(deps());
    await expect(closed.spawn("p", { model: "openai/mock" })).rejects.toThrow(/cannot be resolved: no model catalog/);
    await expect(closed.spawn("p", { model: "  " })).rejects.toThrow("rlm.run model must not be empty");
    await flush();
  });
});
