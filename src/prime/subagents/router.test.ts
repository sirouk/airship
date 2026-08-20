import { describe, expect, it } from "vitest";
import { AGENT_FAMILY_REACH_ERROR, InMemoryPrimeAgentLedger, PrimeAgentRegistry } from "./registry";
import {
  MAX_AGENT_MESSAGE_CHARS,
  type PrimeAgentNodeAttachment,
  type PrimeAgentRegistryDeps,
  type PrimeRuntimeEvent,
} from "./types";
import { createAttached, createFakeClock, createFakeFactory, createFakeIds, createOwner, flush, makeMessage } from "./test-utils.test-support";

/**
 * Nuclear-family routing (manifest invariant 26): parent, siblings, and
 * direct children are reachable; uncles, grandparents, and grandchildren
 * fail closed with the prime-agent family-reach text. Rate limits, the
 * per-receiver pending bound, receipts, reply tracking, and bounded observe
 * snapshots are covered here.
 *
 * Test tree (owner is the registry's scope):
 *   gp (depth 0)
 *   ├─ p0 (depth 1)
 *   │  ├─ owner (depth 2, registry scope)
 *   │  ├─ sib (depth 2)
 *   │  │  (spawned child: depth 3)
 *   │  │    └─ gchild (depth 4, attached)
 *   └─ uncle (depth 1)
 */

interface Family {
  registry: PrimeAgentRegistry;
  grandpa: ReturnType<typeof createAttached>;
  parent: ReturnType<typeof createAttached>;
  sibling: ReturnType<typeof createAttached>;
  uncle: ReturnType<typeof createAttached>;
  ownerSink: ReturnType<typeof createOwner>["sink"];
  factory: ReturnType<typeof createFakeFactory>;
  clock: ReturnType<typeof createFakeClock>;
  events: PrimeRuntimeEvent[];
  ledger: InMemoryPrimeAgentLedger;
}

function buildFamily(options: { clockAdvance?: boolean } = {}): Family {
  void options;
  const factory = createFakeFactory({ default: { text: "ack" } });
  const owner = createOwner({ id: "owner", name: "owner0", depth: 2, parentId: "p0" });
  const clock = createFakeClock();
  const ledger = new InMemoryPrimeAgentLedger();
  const registry = new PrimeAgentRegistry({
    factory: factory.factory,
    owner: owner.node,
    randomId: createFakeIds(),
    now: clock.now,
    ledger,
    env: { RLM_MAX_DEPTH: "5" },
  });
  const grandpa = createAttached({ id: "gp", name: "grandpa", depth: 0 });
  const parent = createAttached({ id: "p0", name: "parent0", depth: 1, parentId: "gp" });
  const sibling = createAttached({ id: "sib", name: "sibling0", depth: 2, parentId: "p0" });
  const uncle = createAttached({ id: "unc", name: "uncle0", depth: 1, parentId: "gp" });
  registry.attachNode(grandpa.node);
  registry.attachNode(parent.node);
  registry.attachNode(sibling.node);
  registry.attachNode(uncle.node);
  const events: PrimeRuntimeEvent[] = [];
  registry.onEvent((event) => events.push(event));
  return { registry, grandpa, parent, sibling, uncle, ownerSink: owner.sink, factory, clock, events, ledger };
}

describe("PrimeAgentRouter reach", () => {
  it("lists exactly the nuclear family and rejects everyone else with the family-reach error", async () => {
    const { registry, factory, grandpa, parent, sibling, uncle } = buildFamily();
    await registry.spawn("child task");
    const childId = factory.created[0]?.childId as string;
    const gchild = createAttached({ id: "gc", name: "gchild", depth: 4, parentId: childId });
    registry.attachNode(gchild.node);

    const reachable = registry.route.reachableAgents("owner").map((handle) => handle.id);
    expect(new Set(reachable)).toEqual(new Set(["p0", "sib", childId]));
    expect(reachable).not.toContain("unc");
    expect(reachable).not.toContain("gp");

    // Happy paths: parent by id, sibling by NAME, child by id.
    await expect(registry.route.send({ fromId: "owner", toId: "p0", content: "hi parent" })).resolves.toMatchObject({
      delivered: true,
    });
    await expect(registry.route.send({ fromId: "owner", toId: "sibling0", content: "hi sibling" })).resolves.toMatchObject(
      { delivered: true },
    );
    await flush();
    await expect(registry.route.send({ fromId: "owner", toId: childId, content: "hi child" })).resolves.toMatchObject({
      delivered: true,
    });

    // Rejections: uncle, grandparent, grandchild — the text names the target AND the rule.
    for (const toId of [uncle.node.id, grandpa.node.id, "uncle0", "gchild", gchild.node.id]) {
      await expect(registry.route.send({ fromId: "owner", toId, content: "nope" })).rejects.toThrow(
        AGENT_FAMILY_REACH_ERROR,
      );
      await expect(registry.route.send({ fromId: "owner", toId, content: "nope" })).rejects.toThrow(toId);
    }
    // A grandchild IS the child's direct child: reachable from the child.
    await expect(registry.route.send({ fromId: childId, toId: "gc", content: "your turn" })).resolves.toMatchObject({
      delivered: true,
    });
    // Unknown senders and unknown targets fail closed too.
    await expect(registry.route.send({ fromId: "ghost", toId: "p0", content: "x" })).rejects.toThrow(
      'Agent "ghost" is not registered in this agent family',
    );
    await expect(registry.route.send({ fromId: "owner", toId: "ghost", content: "x" })).rejects.toThrow(
      AGENT_FAMILY_REACH_ERROR,
    );
  });

  it("validates message text: empty rejected, cap enforced with descriptive counts", async () => {
    const { registry } = buildFamily();
    await expect(registry.route.send({ fromId: "owner", toId: "sib", content: "   " })).rejects.toThrow(
      "Agent session message cannot be empty",
    );
    const oversized = "x".repeat(MAX_AGENT_MESSAGE_CHARS + 1);
    await expect(registry.route.send({ fromId: "owner", toId: "sib", content: oversized })).rejects.toThrow(
      `Agent session message is too long: ${MAX_AGENT_MESSAGE_CHARS + 1} chars exceeds ${MAX_AGENT_MESSAGE_CHARS}`,
    );
    await expect(
      registry.route.send({ fromId: "owner", toId: "sib", content: "x".repeat(MAX_AGENT_MESSAGE_CHARS) }),
    ).resolves.toMatchObject({ delivered: true });
  });

  it("enforces the token-bucket rate limit per sender with a soft receipt, refilling over time", async () => {
    const { registry, clock } = buildFamily();
    const send = () => registry.route.send({ fromId: "owner", toId: "sib", content: "tick" });
    for (let index = 0; index < 3; index += 1) {
      await expect(send()).resolves.toMatchObject({ delivered: true });
    }
    const limited = await send();
    expect(limited.delivered).toBe(false);
    expect(limited.queued).toBe(false);
    expect(limited.reason).toMatch(/Rate limit exceeded for sender "owner0" \(owner\): retry after \d+ms/);

    clock.advance(1_000);
    await expect(send()).resolves.toMatchObject({ delivered: true });

    // A different sender has its own bucket.
    for (let index = 0; index < 3; index += 1) {
      await expect(registry.route.send({ fromId: "sib", toId: "owner", content: "tock" })).resolves.toMatchObject({
        delivered: true,
      });
    }
    await expect(registry.route.send({ fromId: "sib", toId: "owner", content: "tock" })).resolves.toMatchObject({
      delivered: false,
    });
  });

  it("rejects sends to a receiver at the pending bound with a capacity error", async () => {
    const { registry, sibling } = buildFamily();
    sibling.sink.setPending(20);
    await expect(registry.route.send({ fromId: "owner", toId: "sib", content: "overflow" })).rejects.toThrow(
      "Target session has too many pending messages: 20 unfinished, limit is 20",
    );
    sibling.sink.setPending(19);
    await expect(registry.route.send({ fromId: "owner", toId: "sib", content: "fits" })).resolves.toMatchObject({
      delivered: true,
    });
  });

  it("maps sink acceptance to receipts: delivered vs queued", async () => {
    const { registry, sibling, parent } = buildFamily();
    sibling.sink.mode = "queued";
    const queued = await registry.route.send({ fromId: "owner", toId: "sib", content: "wait your turn" });
    expect(queued.delivered).toBe(false);
    expect(queued.queued).toBe(true);
    expect(queued.messageId).toMatch(/^agentmsg_/);

    const delivered = await registry.route.send({ fromId: "owner", toId: parent.node.id, content: "now" });
    expect(delivered.delivered).toBe(true);
    expect(delivered.queued).toBe(false);
  });

  it("marks child -> parent sends as replies: subagent-reply event plus ledger entry", async () => {
    const { registry, factory, events, ledger, ownerSink } = buildFamily();
    const handle = await registry.spawn("investigate the build");
    await flush();
    const receipt = await registry.route.send({
      fromId: handle.id,
      toId: "owner",
      content: "answer: the build is green",
    });
    expect(receipt.delivered).toBe(true);
    expect(ownerSink.accepted.some((message) => message.content === "answer: the build is green")).toBe(true);

    const replies = events.filter((event) => event.type === "subagent-reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      handle: { id: handle.id },
      message: { content: "answer: the build is green", fromId: handle.id, toId: "owner" },
    });

    const kinds = ledger.entries().map((entry) => entry.kind);
    expect(kinds).toContain("reply");
    const replyEntry = ledger.entries().find((entry) => entry.kind === "reply");
    expect(replyEntry?.agentIds).toEqual([handle.id, "owner"]);
  });
});

describe("PrimeAgentRouter observe", () => {
  it("returns bounded recent snapshots, clips oversized content, and clamps parameters", async () => {
    const { registry, sibling } = buildFamily();
    for (let index = 0; index < 5; index += 1) {
      sibling.recorder.messages.push(makeMessage({ id: `m${index}`, content: `note ${index}` }));
    }
    const recent = registry.route.recentMessages("sib", 3, 800);
    expect(recent.map((message) => message.id)).toEqual(["m2", "m3", "m4"]);

    sibling.recorder.messages.push(makeMessage({ id: "huge", content: "h".repeat(300) }));
    const clipped = registry.route.recentMessages("sibling0", 1, 100);
    expect(clipped).toHaveLength(1);
    expect(clipped[0]?.content.length).toBe(100);

    expect(() => registry.route.recentMessages("sib", 0, 800)).toThrow("agent_observe limit must be between 1 and 50");
    expect(() => registry.route.recentMessages("sib", 51, 800)).toThrow("agent_observe limit must be between 1 and 50");
    expect(() => registry.route.recentMessages("sib", 1.5, 800)).toThrow("agent_observe limit must be an integer");
    expect(() => registry.route.recentMessages("sib", 8, 79)).toThrow("agent_observe max_chars must be between 80 and 2000");
    expect(() => registry.route.recentMessages("sib", 8, 2001)).toThrow(
      "agent_observe max_chars must be between 80 and 2000",
    );
  });

  it("scopes observe to the family and names missing recorders", async () => {
    const { registry, uncle, parent } = buildFamily();
    await registry.spawn("watched child");
    await flush();
    // The owner's own recorder works; the child's factory-provided recorder works.
    expect(() => registry.route.recentMessages("owner", 8, 800)).not.toThrow();
    const childId = registry.list()[0]?.id as string;
    expect(() => registry.route.recentMessages(childId, 8, 800)).not.toThrow();

    // The uncle is a real node but unreachable: observe names the rule.
    expect(uncle.node.id).toBe("unc");
    expect(() => registry.route.recentMessages("uncle0", 8, 800)).toThrow(new RegExp(AGENT_FAMILY_REACH_ERROR));
    // Attached node with no recorder is a named failure, not a silent empty page.
    registry.attachNode({ ...parent.node, id: "nr", name: "no-recorder", parentId: "owner", recorder: undefined });
    expect(() => registry.route.recentMessages("nr", 8, 800)).toThrow('Agent "nr" has no message recorder available');
  });
});
