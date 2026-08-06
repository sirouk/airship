import { describe, expect, it } from "vitest";
import type { PrimeRuntimeEvent } from "../runtime/types-prime";
import { InMemoryPrimeAgentLedger, PrimeAgentRegistry } from "./registry";
import { createDeferred, createFakeFactory, createFakeIds, createOwner, createUsage, flush } from "./test-utils";

/**
 * Completion notices (manifest invariant 26): a child either explicitly
 * replies (terminal reason "replied"), or the host synthesizes the terminal
 * notice with a bounded last-assistant-text preview — failure names
 * "failed", a parent-driven or factory-level stop names "stopped".
 * Completed children stay listed until reaped, and usage is latched for the
 * parent session's attribution fold.
 */

function registryWith(events: PrimeRuntimeEvent[], scripts: Parameters<typeof createFakeFactory>[0] = {}) {
  const factory = createFakeFactory(scripts);
  const owner = createOwner();
  const ledger = new InMemoryPrimeAgentLedger();
  const registry = new PrimeAgentRegistry({
    factory: factory.factory,
    owner: owner.node,
    randomId: createFakeIds(),
    ledger,
  });
  registry.onEvent((event) => events.push(event));
  return { registry, factory, owner, ledger };
}

function terminalsOf(events: PrimeRuntimeEvent[]) {
  return events.filter((event) => event.type === "subagent-terminal");
}

describe("PrimeAgentRegistry completion contract", () => {
  it("explicit agent-messages to the parent produce terminal reason replied", async () => {
    const gate = createDeferred<unknown>();
    const events: PrimeRuntimeEvent[] = [];
    const { registry, factory, owner, ledger } = registryWith(events, {
      default: { text: "scan finished", respondAfter: gate.promise, usage: createUsage(7) },
    });
    const handle = await registry.spawn("scan the fleet");
    await flush();
    const childSink = factory.byChildId(handle.id).sink;
    expect(childSink.accepted.some((message) => message.id === `spawn:${handle.id}`)).toBe(true);
    expect(owner.sink.accepted.some((message) => message.id.startsWith("spawn:"))).toBe(false);

    const receipt = await registry.route.send({
      fromId: handle.id,
      toId: "owner",
      content: "answer: fleet is nominal",
    });
    expect(receipt.delivered).toBe(true);
    gate.resolve(undefined);
    await flush();

    const terminals = terminalsOf(events);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ reason: "replied", preview: "answer: fleet is nominal" });
    const replies = events.filter((event) => event.type === "subagent-reply");
    expect(replies).toHaveLength(1);
    expect(events.indexOf(replies[0] as PrimeRuntimeEvent)).toBeLessThan(events.indexOf(terminals[0] as PrimeRuntimeEvent));

    // Status: completed children go idle and STAY LISTED until reaped; the
    // reply itself is the notice, so no synthesized one lands in the sink.
    expect(registry.list()[0]?.status).toBe("idle");
    expect(owner.sink.accepted.some((message) => message.content.includes("completed without sending a reply"))).toBe(
      false,
    );
    expect(owner.sink.accepted.some((message) => message.content === "answer: fleet is nominal")).toBe(true);
    expect(registry.usageOf(handle.id)?.totalTokens).toBe(7);

    const kinds = ledger.entries().map((entry) => entry.kind);
    expect(kinds).toEqual(["spawn", "message", "message", "reply", "terminal"]);
    expect(ledger.entries()[4]?.detail?.reason).toBe("replied");
  });

  it("a silent end of the turn loop produces completed_without_reply with a bounded preview and a parent notice", async () => {
    const events: PrimeRuntimeEvent[] = [];
    const { registry, factory, owner, ledger } = registryWith(events, { default: { text: "quiet result" } });
    const handle = await registry.spawn("work silently");
    await flush();

    const terminals = terminalsOf(events);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ reason: "completed_without_reply", preview: "quiet result" });
    expect(registry.list()[0]?.status).toBe("idle");
    // The runtime stays reachable (registry.get) until the child is reaped.
    expect(registry.get(handle.id)).toBe(factory.byChildId(handle.id).runtime);
    expect(registry.get(handle.name)).toBe(factory.byChildId(handle.id).runtime);
    expect(registry.get("nope")).toBeUndefined();

    const notice = owner.sink.accepted.find((message) => message.content.includes("completed without sending a reply"));
    expect(notice?.content).toBe(
      `RLM child ${handle.name} (${handle.id}) completed without sending a reply. Last assistant text: quiet result`,
    );

    const kinds = ledger.entries().map((entry) => entry.kind);
    expect(kinds).toEqual(["spawn", "message", "terminal"]);
    expect(ledger.entries()[2]?.detail?.reason).toBe("completed_without_reply");
  });

  it("bounds the completed_without_reply preview to 512 chars", async () => {
    const events: PrimeRuntimeEvent[] = [];
    const { registry, owner } = registryWith(events, { default: { text: "y".repeat(1_000) } });
    await registry.spawn("write something long");
    await flush();
    const terminal = terminalsOf(events)[0];
    expect(terminal?.type).toBe("subagent-terminal");
    if (terminal?.type === "subagent-terminal") {
      expect(terminal.reason).toBe("completed_without_reply");
      expect(terminal.preview?.length).toBe(512);
    }
    const notice = owner.sink.accepted.find((message) => message.content.includes("completed without sending a reply"));
    expect(notice).toBeDefined();
    expect(notice?.content.length).toBeLessThan(1_000);
  });

  it("a failing child settles with terminal reason failed and a named error", async () => {
    const events: PrimeRuntimeEvent[] = [];
    const { registry, owner } = registryWith(events, { default: { fail: "boom: provider exploded" } });
    const handle = await registry.spawn("attempt the thing");
    await flush();
    const terminal = terminalsOf(events)[0];
    expect(terminal).toMatchObject({ reason: "failed", preview: "boom: provider exploded" });
    expect(registry.list()[0]?.status).toBe("failed");
    const notice = owner.sink.accepted.find((message) => message.content.includes("boom: provider exploded"));
    expect(notice?.content).toBe(`RLM child ${handle.name} (${handle.id}) failed: boom: provider exploded`);
  });

  it("stop settles a running child as stopped, exactly once, even across a late finish", async () => {
    const gate = createDeferred<unknown>();
    const events: PrimeRuntimeEvent[] = [];
    const { registry, factory, owner } = registryWith(events, {
      default: { text: "late answer", respondAfter: gate.promise },
    });
    const handle = await registry.spawn("long job");
    await flush();

    await expect(registry.stop(handle.id, "test cancellation")).resolves.toBe(true);
    expect(factory.byChildId(handle.id).stopReasons).toEqual(["test cancellation"]);
    await flush();
    expect(terminalsOf(events)).toHaveLength(1);
    expect(terminalsOf(events)[0]).toMatchObject({ reason: "stopped", preview: "test cancellation" });
    expect(registry.list()[0]?.status).toBe("stopped");
    expect(owner.sink.accepted.some((message) => message.content.includes("was stopped: test cancellation"))).toBe(true);

    // Now the run actually finishes: the settled guard keeps terminal count at one.
    gate.resolve(undefined);
    await flush();
    expect(terminalsOf(events)).toHaveLength(1);

    // Second stop on a settled child is a no-op; unknown ids are not found.
    await expect(registry.stop(handle.id, "again")).resolves.toBe(false);
    await expect(registry.stop("never-spawned", "x")).resolves.toBe(false);
  });

  it("stop requested before the factory resolves latches onto the arriving bundle", async () => {
    const events: PrimeRuntimeEvent[] = [];
    const { registry, factory } = registryWith(events);
    const gateCreate = factory.deferNextCreate();
    const handle = await registry.spawn("slow-starting child");
    await expect(registry.stop(handle.id, "early stop")).resolves.toBe(true);
    // Not settled yet: the bundle the stop should land on has not arrived.
    expect(registry.list()[0]?.status).toBe("running");
    expect(terminalsOf(events)).toHaveLength(0);

    gateCreate.resolve(factory.buildBundle(factory.created[0] as Parameters<typeof factory.buildBundle>[0]));
    await flush();
    expect(terminalsOf(events)).toHaveLength(1);
    expect(terminalsOf(events)[0]).toMatchObject({ reason: "stopped", preview: "early stop" });
    expect(factory.byChildId(handle.id).stopReasons).toEqual(["early stop"]);
    expect(registry.list()[0]?.status).toBe("stopped");
  });

  it("a factory throw settles the run as stopped with the error named", async () => {
    const events: PrimeRuntimeEvent[] = [];
    const { registry, factory, owner } = registryWith(events);
    factory.failNextCreateWith(new Error("no gpu available"));
    const handle = await registry.spawn("needs hardware");
    await flush();
    const terminal = terminalsOf(events)[0];
    expect(terminal).toMatchObject({ reason: "stopped", preview: "no gpu available" });
    expect(registry.list()[0]?.status).toBe("stopped");
    expect(owner.sink.accepted.some((message) => message.content.includes("was stopped: no gpu available"))).toBe(true);
    expect(registry.usageOf(handle.id)).toBeUndefined();
  });

  it("reapCompleted drains completed children, stops their runtimes, and returns the count", async () => {
    const events: PrimeRuntimeEvent[] = [];
    const { registry, factory } = registryWith(events, { default: { text: "quick" } });
    const first = await registry.spawn("job one");
    const second = await registry.spawn("job two");
    await flush();
    expect(registry.list().map((handle) => handle.status)).toEqual(["idle", "idle"]);

    // Third child pinned behind a never-answered factory create: it stays
    // running and must not be drained.
    factory.deferNextCreate();
    const third = await registry.spawn("job three");
    expect(registry.list().map((handle) => handle.status)).toEqual(["idle", "idle", "running"]);
    expect(registry.usageOf(third.id)).toBeUndefined();

    await expect(registry.reapCompleted()).resolves.toBe(2);
    expect(registry.list().map((handle) => handle.id)).toEqual([third.id]);
    expect(factory.byChildId(first.id).stopReasons).toEqual(["reaped"]);
    expect(factory.byChildId(second.id).stopReasons).toEqual(["reaped"]);
    expect(registry.get(first.id)).toBeUndefined();

    await expect(registry.reapCompleted()).resolves.toBe(0);
  });
});
