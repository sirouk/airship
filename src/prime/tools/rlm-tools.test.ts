/**
 * The prime RLM tool surface end-to-end over the REAL registry primitives
 * (src/prime/subagents/registry.ts) wired with the in-memory doubles from
 * ../subagents/test-utils. These are thin-tool tests: the pins are the
 * translation and pre-check layers (admission-only spawn, data-shaped
 * refusals, depth ladder, receipts, bounded observe), while the deep
 * orchestration itself is covered by the registry's own suite.
 *
 * Family used by the messaging/observe tests (owner is registry scope):
 *   p0 (depth 1) ── owner (depth 2, self) ── spawned children (depth 3)
 *               └─ sib (depth 2)
 *   unc (depth 1, attached but unreachable: the uncle)
 */
import { describe, expect, it } from "vitest";
import {
  createPrimeAgentMessageTool,
  createPrimeAgentObserveTool,
  createPrimeRlmSpawnTool,
  createPrimeSubagentTool,
  type PrimeRlmAgentDeps,
  type PrimeRlmSelfIdentity,
} from "./rlm-tools";
import { AGENT_FAMILY_REACH_ERROR, PrimeAgentRegistry } from "../subagents/registry";
import type { PrimeHarnessEntry, PrimeHarnessScope, PrimeHarnessStore } from "../runtime/types-prime";
import { createAttached, createFakeClock, createFakeFactory, createFakeIds, createOwner, flush, makeMessage } from "../subagents/test-utils.test-support";
import { makeToolContext } from "./test-utils.test-support";

/** Map-backed harness double; a twin of the admission.test.ts double (test-utils carries none). */
function createFakeHarnessStore(): { store: PrimeHarnessStore; entries: Map<string, PrimeHarnessEntry> } {
  const entries = new Map<string, PrimeHarnessEntry>();
  const keyOf = (scope: string, kind: string, id: string): string => `${scope}:${kind}:${id}`;
  const store: PrimeHarnessStore = {
    list: async (scope, kind) =>
      [...entries.values()].filter(
        (entry) => (scope === undefined || entry.scope === scope) && (kind === undefined || entry.kind === kind),
      ),
    get: async (scope, kind, id) => entries.get(keyOf(scope, kind, id)),
    create: async (scope, input) => {
      const materialized = {
        ...input,
        id: input.id ?? `entry:${String(entries.size)}`,
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
    applyRefinement: () => Promise.reject(new Error("not implemented in test double")),
    rollback: () => Promise.reject(new Error("not implemented in test double")),
    snapshot: async () => Object.freeze({ schema: 1, entries: [...entries.values()], refinements: [] }),
    restore: async () => undefined,
    snapshotId: async () => "s",
  };
  return { store, entries };
}

interface ToolFamily {
  deps: PrimeRlmAgentDeps;
  registry: PrimeAgentRegistry;
  factory: ReturnType<typeof createFakeFactory>;
  owner: ReturnType<typeof createOwner>;
  parent: ReturnType<typeof createAttached>;
  sibling: ReturnType<typeof createAttached>;
  uncle: ReturnType<typeof createAttached>;
  clock: ReturnType<typeof createFakeClock>;
}

/** owner at depth 2 with attached parent, sibling, and uncle; env RLM_MAX_DEPTH=5 leaves spawn headroom. */
function buildFamily(
  env: Readonly<Record<string, string | undefined>> = { RLM_MAX_DEPTH: "5" },
  script: Parameters<typeof createFakeFactory>[0] = { default: { text: "ack" } },
): ToolFamily {
  const factory = createFakeFactory(script);
  const owner = createOwner({ id: "owner", name: "owner0", depth: 2, parentId: "p0" });
  const clock = createFakeClock();
  const registry = new PrimeAgentRegistry({
    factory: factory.factory,
    owner: owner.node,
    randomId: createFakeIds(),
    now: clock.now,
    env,
  });
  const parent = createAttached({ id: "p0", name: "parent0", depth: 1, parentId: "gp" });
  const sibling = createAttached({ id: "sib", name: "sibling0", depth: 2, parentId: "p0" });
  const uncle = createAttached({ id: "unc", name: "uncle0", depth: 1, parentId: "gp" });
  registry.attachNode(parent.node);
  registry.attachNode(sibling.node);
  registry.attachNode(uncle.node);
  const self = Object.freeze({ id: "owner", name: "owner0", depth: 2, parentId: "p0" }) satisfies PrimeRlmSelfIdentity;
  return { deps: { self, registry }, registry, factory, owner, parent, sibling, uncle, clock };
}

/** Minimal registry whose owner sits at a chosen depth, for the depth-gate scenarios. */
function buildDepthDeps(options: {
  depth: number;
  env?: Readonly<Record<string, string | undefined>>;
  store?: PrimeHarnessStore;
}): { deps: PrimeRlmAgentDeps; registry: PrimeAgentRegistry } {
  const factory = createFakeFactory({ default: { text: "ack" } });
  const owner = createOwner({ id: "owner", name: "owner0", depth: options.depth });
  const registry = new PrimeAgentRegistry({
    factory: factory.factory,
    owner: owner.node,
    randomId: createFakeIds(),
    ...(options.env ? { env: options.env } : {}),
    ...(options.store ? { harnessStore: options.store } : {}),
  });
  const self = Object.freeze({ id: "owner", name: "owner0", depth: options.depth }) satisfies PrimeRlmSelfIdentity;
  return { deps: { self, registry }, registry };
}

describe("prime rlm_spawn", () => {
  it("admits immediately with the upstream handle-shape result and never awaits the child's answer", async () => {
    const family = buildFamily();
    const gate = family.factory.deferNextCreate();
    const tool = createPrimeRlmSpawnTool(family.deps);

    // The factory promise stays unresolved the whole time; the tool must still resolve.
    const result = await tool.execute({ prompt: "Summarize the release notes" }, makeToolContext());
    expect(result.isError).toBeUndefined();
    expect(family.factory.created).toHaveLength(1);
    expect(result.content).toContain('Spawned child agent "subagent-summarize-the-release-notes-00000001"');
    expect(result.content).toContain("admitted at depth 3");
    expect(result.content).toContain("the answer is never returned here");
    expect(result.content).toContain('"rlm_child_id": "sub-00000002"');
    expect(result.content).toContain('"session_dir": "/sessions/owner/sub-00000002"');
    expect(result.content).toContain('"model": "mock"');
    expect(result.metadata).toMatchObject({
      rlm_child_id: "sub-00000002",
      name: "subagent-summarize-the-release-notes-00000001",
      session_dir: "/sessions/owner/sub-00000002",
      model: "mock",
      depth: 3,
      maxDepth: 5,
      maxDepthSource: "env",
    });

    // Materialize belatedly: admission really had returned before the runtime existed.
    gate.resolve(family.factory.buildBundle(family.factory.created[0] as Parameters<typeof family.factory.buildBundle>[0]));
    await flush();
    expect(family.registry.list()[0]?.status).toBe("idle");
  });

  it("refuses a duplicate child name with the existing sibling named", async () => {
    const family = buildFamily();
    // Gate the first child's runtime so its status is deterministically "running" at refusal time.
    const gate = family.factory.deferNextCreate();
    const tool = createPrimeRlmSpawnTool(family.deps);
    const first = await tool.execute({ prompt: "task one", name: "racer" }, makeToolContext());
    expect(first.isError).toBeUndefined();

    const second = await tool.execute({ prompt: "task two", name: "racer" }, makeToolContext());
    expect(second.isError).toBe(true);
    expect(second.content).toBe(
      'Child name "racer" is already taken by sibling sub-00000001 (running); choose a unique name.',
    );
    expect(second.metadata).toMatchObject({ refused: "duplicate-name", name: "racer", existing: { id: "sub-00000001" } });

    const invalid = await tool.execute({ prompt: "p", name: "bad name!" }, makeToolContext());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('Invalid child name "bad name!"');
    expect(invalid.metadata).toMatchObject({ refused: "invalid-name", name: "bad name!" });
    gate.resolve(family.factory.buildBundle(family.factory.created[0] as Parameters<typeof family.factory.buildBundle>[0]));
    await flush();
  });

  it("depth-gates at the default ceiling (depth 1) with the source named", async () => {
    const { deps } = buildDepthDeps({ depth: 1 });
    const tool = createPrimeRlmSpawnTool(deps);
    const result = await tool.execute({ prompt: "too deep" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "RLM recursion depth limit reached (depth=1, max=1, source=default): " +
        "child sessions at the ceiling cannot spawn further agents.",
    );
    expect(result.metadata).toEqual({ depth: 1, maxDepth: 1, maxDepthSource: "default" });
  });

  it("applies the chat-override over env via setRlmMaxDepth, persisted per chat", async () => {
    const harness = createFakeHarnessStore();
    const deep = buildDepthDeps({ depth: 4, env: { RLM_MAX_DEPTH: "1" }, store: harness.store });
    await deep.registry.setRlmMaxDepth(5);
    expect(await deep.registry.getMaxDepthStatus()).toEqual({ maxDepth: 5, source: "chat" });
    // Persisted under the reserved subagent entry, chat (local) scope.
    expect(harness.entries.get("local:subagent:subagent:max-depth")).toMatchObject({
      kind: "subagent",
      scope: "local",
      metadata: { maxDepth: 5 },
    });

    // Depth 4 admits with the chat source named: chat (5) beat env (1).
    const tool = createPrimeRlmSpawnTool(deep.deps);
    const admitted = await tool.execute({ prompt: "deep work", name: "deep-worker" }, makeToolContext());
    expect(admitted.isError).toBeUndefined();
    expect(admitted.metadata).toMatchObject({ depth: 5, maxDepth: 5, maxDepthSource: "chat" });

    // A fresh registry over the same store picks the chat override up (precedence chat > env).
    const ceiling = buildDepthDeps({ depth: 5, env: { RLM_MAX_DEPTH: "1" }, store: harness.store });
    expect(await ceiling.registry.getMaxDepthStatus()).toEqual({ maxDepth: 5, source: "chat" });
    const refused = await createPrimeRlmSpawnTool(ceiling.deps).execute({ prompt: "too deep" }, makeToolContext());
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("RLM recursion depth limit reached (depth=5, max=5, source=chat)");
    expect(refused.metadata).toEqual({ depth: 5, maxDepth: 5, maxDepthSource: "chat" });
    await flush();
  });
});

describe("prime agent_message", () => {
  it("delivers to parent and sibling with receipts naming delivered + the rate-limit posture", async () => {
    const family = buildFamily();
    const tool = createPrimeAgentMessageTool(family.deps);

    // The parent is unambiguous: no receiver id/name narrows the one parent row.
    const toParent = await tool.execute(
      { action: "send", receiver_role: "parent", message: "hi parent" },
      makeToolContext(),
    );
    expect(toParent.isError).toBeUndefined();
    expect(toParent.content).toMatch(/^Message to parent0 delivered \(agentmsg_[0-9a-f]+\)\./);
    expect(toParent.metadata).toMatchObject({ delivered: true, target: { id: "p0", name: "parent0" } });
    expect(family.parent.sink.accepted.map((message) => message.content)).toContain("hi parent");

    const toSibling = await tool.execute(
      { action: "send", receiver_role: "sibling", receiver_name: "sibling0", message: "hi sibling" },
      makeToolContext(),
    );
    expect(toSibling.isError).toBeUndefined();
    expect(toSibling.content).toMatch(/^Message to sibling0 delivered \(agentmsg_[0-9a-f]+\)\./);
    expect(toSibling.content).toContain("Do not block waiting for a reply");
    expect(toSibling.metadata).toMatchObject({
      delivered: true,
      queued: false,
      rateLimit: { burstCapacity: 3, refillPerSecond: 1, pendingCap: 20 },
      target: { id: "sib", name: "sibling0" },
    });
    expect(family.sibling.sink.accepted.map((message) => message.content)).toContain("hi sibling");

    const roster = await tool.execute({ action: "list_agents" }, makeToolContext());
    const parsed = JSON.parse(roster.content) as {
      self: { id: string; name: string; depth: number };
      agents: { id: string; name: string; familyRole: string }[];
      count: number;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.agents.map((agent) => `${agent.id}:${agent.familyRole}`).sort()).toEqual(["p0:parent", "sib:sibling"]);
  });

  it("delivers to a spawned child resolved by receiver_id", async () => {
    const family = buildFamily();
    const child = await family.registry.spawn("child task");
    await flush();
    const tool = createPrimeAgentMessageTool(family.deps);
    const result = await tool.execute(
      { action: "send", receiver_role: "child", receiver_id: child.id, message: "status?" },
      makeToolContext(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({ delivered: true, target: { id: child.id, name: child.name } });
    const childSink = family.factory.byChildId(child.id).sink;
    expect(childSink.accepted.map((message) => message.content)).toContain("status?");
  });

  it("refuses an uncle with the nuclear-family sentence and the reachable alternatives named", async () => {
    const family = buildFamily();
    const tool = createPrimeAgentMessageTool(family.deps);
    const result = await tool.execute(
      { action: "send", receiver_role: "sibling", receiver_name: "uncle0", message: "hello uncle" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("owner0 has no reachable sibling named uncle0");
    expect(result.content).toContain(AGENT_FAMILY_REACH_ERROR);
    expect(result.content).toContain("sibling0 (sib)");
    expect(result.metadata).toMatchObject({ refused: "family-reach", requestedRole: "sibling", requested: "uncle0", reachableCount: 1 });
  });

  it("tells a root it has no parent: roots are siblings of one another", async () => {
    const factory = createFakeFactory();
    const owner = createOwner({ id: "owner", name: "owner0", depth: 0 });
    const registry = new PrimeAgentRegistry({ factory: factory.factory, owner: owner.node, randomId: createFakeIds() });
    registry.attachNode(createAttached({ id: "sib", name: "sibling0", depth: 0 }).node);
    const self = Object.freeze({ id: "owner", name: "owner0", depth: 0 }) satisfies PrimeRlmSelfIdentity;
    const tool = createPrimeAgentMessageTool({ self, registry });

    const result = await tool.execute({ action: "send", receiver_role: "parent", message: "hello parent" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "owner0 (a root) has no parent in this family; roots are siblings of one another. " +
        `${AGENT_FAMILY_REACH_ERROR}. Reachable parents: none.`,
    );
    expect(result.metadata).toMatchObject({ refused: "family-reach", requestedRole: "parent", requested: null, reachableCount: 0 });
  });

  it("surfaces the pending cap as an isError refusal naming the bound", async () => {
    const family = buildFamily();
    family.sibling.sink.setPending(20);
    const tool = createPrimeAgentMessageTool(family.deps);
    const result = await tool.execute(
      { action: "send", receiver_role: "sibling", receiver_name: "sibling0", message: "overflow" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Message to sibling0 was refused: Target session has too many pending messages: 20 unfinished, limit is 20",
    );
    expect(result.metadata).toMatchObject({ refused: true });

    family.sibling.sink.setPending(19);
    const fits = await tool.execute(
      { action: "send", receiver_role: "sibling", receiver_name: "sibling0", message: "fits" },
      makeToolContext(),
    );
    expect(fits.metadata).toMatchObject({ delivered: true });
  });

  it("maps the soft rate-limit receipt to data: delivered false, retry named, posture attached", async () => {
    const family = buildFamily();
    const tool = createPrimeAgentMessageTool(family.deps);
    const send = () =>
      tool.execute({ action: "send", receiver_role: "sibling", receiver_name: "sibling0", message: "tick" }, makeToolContext());
    for (let index = 0; index < 3; index += 1) {
      expect((await send()).metadata).toMatchObject({ delivered: true });
    }
    const limited = await send();
    expect(limited.isError).toBe(true);
    expect(limited.content).toMatch(
      /^Message to sibling0 was refused: Rate limit exceeded for sender "owner0" \(owner\): retry after \d+ms$/,
    );
    const metadata = limited.metadata as Record<string, unknown>;
    expect(metadata.delivered).toBe(false);
    expect(metadata.queued).toBe(false);
    expect(typeof metadata.reason).toBe("string");
    expect((metadata.reason as string).length).toBeGreaterThan(0);
    expect(metadata.rateLimited).toBe(true);
    expect(metadata.retryAfterMs).toBe(1_000);
    expect(metadata.rateLimit).toEqual({ burstCapacity: 3, refillPerSecond: 1, pendingCap: 20 });

    family.clock.advance(1_000);
    expect((await send()).metadata).toMatchObject({ delivered: true });
  });
});

describe("prime agent_observe", () => {
  it("clamps limit/max_chars before any roster access", async () => {
    const family = buildFamily();
    const tool = createPrimeAgentObserveTool(family.deps);
    await expect(tool.execute({ action: "recent_messages", limit: 0 }, makeToolContext())).rejects.toThrow(
      "limit must be between 1 and 50.",
    );
    await expect(tool.execute({ action: "recent_messages", limit: 51 }, makeToolContext())).rejects.toThrow(
      "limit must be between 1 and 50.",
    );
    await expect(tool.execute({ action: "recent_messages", max_chars: 79 }, makeToolContext())).rejects.toThrow(
      "max_chars must be between 80 and 2000.",
    );
    await expect(tool.execute({ action: "recent_messages", max_chars: 2_001 }, makeToolContext())).rejects.toThrow(
      "max_chars must be between 80 and 2000.",
    );
  });

  it("reads recent messages in stable order, clipped at max_chars honestly flagged", async () => {
    const family = buildFamily();
    for (let index = 0; index < 5; index += 1) {
      family.sibling.recorder.messages.push(makeMessage({ id: `m${String(index)}`, content: `note ${String(index)}` }));
    }
    const tool = createPrimeAgentObserveTool(family.deps);
    const recent = await tool.execute(
      { action: "recent_messages", agent: "sib", limit: 3, max_chars: 800 },
      makeToolContext(),
    );
    const parsed = JSON.parse(recent.content) as {
      agent: string;
      count: number;
      messages: { id: string; content: string; reachedClipBound: boolean }[];
    };
    expect(parsed.agent).toBe("sib");
    expect(parsed.count).toBe(3);
    expect(parsed.messages.map((message) => message.id)).toEqual(["m2", "m3", "m4"]);
    expect(parsed.messages.map((message) => message.reachedClipBound)).toEqual([false, false, false]);
    expect(recent.metadata).toMatchObject({ agent: "sib", count: 3, limit: 3, maxChars: 800 });

    family.sibling.recorder.messages.push(makeMessage({ id: "huge", content: "h".repeat(300) }));
    const clipped = await tool.execute(
      { action: "recent_messages", agent: "sibling0", limit: 1, max_chars: 100 },
      makeToolContext(),
    );
    const clippedParsed = JSON.parse(clipped.content) as { messages: { id: string; content: string; reachedClipBound: boolean }[] };
    expect(clippedParsed.messages).toHaveLength(1);
    expect(clippedParsed.messages[0]?.id).toBe("huge");
    expect(clippedParsed.messages[0]?.content).toBe("h".repeat(100));
    expect(clippedParsed.messages[0]?.reachedClipBound).toBe(true);
  });

  it("lists and gets reachable handles; the uncle is not observable with the family sentence named", async () => {
    const family = buildFamily();
    const tool = createPrimeAgentObserveTool(family.deps);
    const list = await tool.execute({ action: "list" }, makeToolContext());
    const parsed = JSON.parse(list.content) as { agents: { id: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.agents.map((agent) => agent.id).sort()).toEqual(["p0", "sib"]);

    const got = await tool.execute({ action: "get", agent: "sibling0" }, makeToolContext());
    expect(got.isError).toBeUndefined();
    expect(got.metadata).toMatchObject({ handle: { id: "sib", name: "sibling0", depth: 2 } });

    const uncle = await tool.execute({ action: "get", agent: "uncle0" }, makeToolContext());
    expect(uncle.isError).toBe(true);
    expect(uncle.content).toBe(
      'Agent "uncle0" is not observable from owner0: agent reach is limited to parent, siblings, and children.',
    );
    expect(uncle.metadata).toMatchObject({ refused: "family-reach", agent: "uncle0", observableCount: 2 });
  });
});

describe("prime subagent", () => {
  it("lists spawned children and stops one by id with the terminal notice promised", async () => {
    // neverStart keeps both children "running" so the stop below is a real stop.
    const family = buildFamily({ RLM_MAX_DEPTH: "5" }, { default: { neverStart: true } });
    const first = await family.registry.spawn("first task");
    await family.registry.spawn("second task");
    const tool = createPrimeSubagentTool(family.deps);

    const list = await tool.execute({ action: "list" }, makeToolContext());
    const parsed = JSON.parse(list.content) as { children: { id: string; name: string; depth: number; status: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.children[0]).toMatchObject({ id: first.id, depth: 3, role: "subagent", parentId: "owner" });

    const missing = await tool.execute({ action: "stop", child: "ghost" }, makeToolContext());
    expect(missing.isError).toBe(true);
    expect(missing.content).toBe('No running direct child named "ghost"; only direct children this agent spawned can be stopped.');
    expect(missing.metadata).toMatchObject({ child: "ghost", stopped: false });

    const stopped = await tool.execute({ action: "stop", child: first.id, reason: "done with you" }, makeToolContext());
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toBe(
      `Stopped child "${first.id}" (done with you); its terminal notice will arrive as an agent_message result.`,
    );
    expect(stopped.metadata).toMatchObject({ child: first.id, stopped: true, reason: "done with you" });
    await flush();
  });
});
