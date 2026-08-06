import { describe, expect, it } from "vitest";
import {
  HarnessApplyRejectedError,
  HarnessKvConflictError,
  HarnessStoreBase,
  InMemoryHarnessKvAdapter,
  InMemoryHarnessStore,
  OptimisticConcurrencyError,
  canonicalSkillReference,
  resolveHarnessRef,
  slugHarnessId,
  stableStringify,
  validateRefinementEdits,
  type HarnessKvAdapter,
  type HarnessKvRecord,
  type HarnessKvWrite,
} from "./store";
import type { HarnessEntry, HarnessProposal, HarnessSnapshot } from "./types";

let tick = 1_700_000_000_000;
const now = () => (tick += 1000);

function memoryInput(id: string, content = `content of ${id}`) {
  return { id, kind: "memory" as const, title: `Title ${id}`, content };
}

describe("InMemoryHarnessStore CRUD", () => {
  it("creates, reads, updates, deletes with version increments", async () => {
    const store = new InMemoryHarnessStore({ now });
    const created = await store.create("local", memoryInput("alpha"));
    // no tsc strict-error allowed → assert object
    expect(created).toMatchObject({
      id: "alpha",
      kind: "memory",
      scope: "local",
      version: 1,
      source: "agent",
    });
    expect(await store.get("local", "memory", "alpha")).toMatchObject({ id: "alpha", version: 1 });

    const updated = await store.update("local", "memory", "alpha", { content: "revised" });
    expect(updated.version).toBe(2);
    expect(updated.content).toBe("revised");
    expect(updated.title).toBe("Title alpha");

    expect(await store.delete("local", "memory", "alpha")).toBe(true);
    expect(await store.get("local", "memory", "alpha")).toBeUndefined();
    expect(await store.delete("local", "memory", "alpha")).toBe(false);
  });

  it("keeps scopes segregated and orders list deterministically", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("shared"));
    await store.create("global", memoryInput("shared", "global variant"));
    await store.create("local", memoryInput("beta"));
    const localIds = (await store.list("local")).map((entry) => entry.id);
    expect(localIds).toEqual(["beta", "shared"]);
    expect((await store.list("global")).map((entry) => entry.id)).toEqual(["shared"]);
    expect((await store.get("global", "memory", "shared"))?.content).toBe("global variant");
  });

  it("defaults path and derives ids from titles like upstream slug()", async () => {
    const store = new InMemoryHarnessStore({ now });
    const entry = await store.create("local", { kind: "memory", title: "My First Lesson!", content: "c" });
    expect(entry.id).toBe("my_first_lesson");
    expect(entry.path).toBe("general");
    expect(slugHarnessId("!!!", "memory")).toBe("memory");
  });

  it("rejects duplicate creates and unknown updates", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("alpha"));
    await expect(store.create("local", memoryInput("alpha"))).rejects.toThrow("already exists");
    await expect(store.update("local", "memory", "ghost", { content: "x" })).rejects.toThrow("does not exist");
  });

  it("validates skill references with upstream alias tolerance", () => {
    expect(
      canonicalSkillReference({ type: "python", python_import: "pkg.mod", call_pattern: "await fn()" }),
    ).toEqual({ type: "python", import: "pkg.mod", callPattern: "await fn()" });
    expect(canonicalSkillReference({ type: "python", import: "pkg.mod" })).toBeUndefined();
    expect(canonicalSkillReference({ type: "shell", import: "x", callable: "f" })).toBeUndefined();
    expect(canonicalSkillReference("nope")).toBeUndefined();
  });

  it("rejects mismatched expectedVersion with a named OptimisticConcurrencyError", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("alpha"));
    await store.update("local", "memory", "alpha", { content: "v2" });
    try {
      await store.update("local", "memory", "alpha", { content: "v3" }, { expectedVersion: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OptimisticConcurrencyError);
      const conflict = error as OptimisticConcurrencyError;
      expect(conflict.kind).toBe("memory");
      expect(conflict.entryId).toBe("alpha");
      expect(conflict.message).toContain("memory:alpha");
    }
  });
});

describe("id prefix normalization", () => {
  it("resolves local:/global: display prefixes back to scope routing", () => {
    expect(resolveHarnessRef("local", "global:foo")).toEqual({ scope: "global", id: "foo" });
    expect(resolveHarnessRef("global", "local:bar")).toEqual({ scope: "local", id: "bar" });
    expect(resolveHarnessRef("local", "plain")).toEqual({ scope: "local", id: "plain" });
    expect(resolveHarnessRef("local", "localonly:")).toEqual({ scope: "local", id: "localonly:" });
  });

  it("accepts prefixed ids across CRUD", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("global:wrapped", "stored locally?"));
    // The prefix routes the CREATE to global, mirroring kernel-side _strip_scope_prefix.
    expect(await store.get("global", "memory", "wrapped")).toMatchObject({ scope: "global" });
    expect(await store.get("local", "memory", "wrapped")).toBeUndefined();
    await store.create("local", memoryInput("localwrapped"));
    expect(await store.get("local", "memory", "local:localwrapped")).toMatchObject({ id: "localwrapped" });
    await store.update("local", "memory", "local:localwrapped", { content: "via prefix" });
    expect((await store.get("local", "memory", "localwrapped"))?.content).toBe("via prefix");
  });
});

describe("validateRefinementEdits", () => {
  const base = { scope: "local" as const, source: "manual" as const };

  it("collects named issues for every rule in order", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("exists"));
    const entries = await store.list("local");
    const { issues } = validateRefinementEdits(
      entries,
      [
        { action: "patch" as never, kind: "memory", id: "x" },
        { action: "create", kind: "widget" as never, title: "t", content: "c" },
        { action: "update", kind: "prompt", id: "base_system_prompt", title: "t", content: "c" },
        { action: "update", kind: "memory" },
        { action: "create", kind: "memory", title: "only title" },
        { action: "create", kind: "skill", title: "s", content: "c" },
        { action: "create", kind: "skill", title: "s", content: "c", arguments: {} },
        { action: "update", kind: "memory", id: "ghost", title: "t", content: "c" },
        { action: "delete", kind: "memory", id: "ghost" },
        { action: "create", kind: "memory", id: "exists", title: "t", content: "c" },
      ],
      base,
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "unsupported_action",
      "unsupported_kind",
      "immutable_entry",
      "missing_id",
      "missing_fields",
      "skill_reference_invalid",
      "skill_reference_invalid",
      "entry_not_found",
      "entry_not_found",
      "entry_exists",
    ]);
    // Positioned: the caller can map issues back to the model's edit list.
    expect(issues.map((issue) => issue.editIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("accepts skill edits with a full python reference and reports the canonical shape", () => {
    const { issues, prepared } = validateRefinementEdits(
      [],
      [
        {
          action: "create",
          kind: "skill",
          title: "web lookup",
          content: "search the web",
          reference: { type: "python", import: "websearch", callable: "run" },
          arguments: { query: { type: "string", required: true } },
        },
      ],
      { scope: "local", source: "manual" },
    );
    expect(issues).toEqual([]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.reference).toEqual({ type: "python", import: "websearch", callable: "run" });
  });

  it("rejects the optimistic baseline conflict as a named issue, not an error", async () => {
    const store = new InMemoryHarnessStore({ now });
    const created = await store.create("local", memoryInput("alpha"));
    const baseline = [created];
    // Another writer mutates the entry between plan and apply.
    await store.update("local", "memory", "alpha", { content: "concurrent change" });
    const { issues } = validateRefinementEdits(
      await store.list("local"),
      [{ action: "update", kind: "memory", id: "alpha", title: "t", content: "planned" }],
      { scope: "local", source: "manual", baseline },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "optimistic_conflict", id: "alpha" });
    expect(issues[0]?.message).toBe("entry changed during refinement planning");
  });
});

describe("applyRefinement", () => {
  it("applies valid multi-edit proposals atomically with full before/after snapshots", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("keep"));
    await store.create("local", memoryInput("drop"));
    const proposal: HarnessProposal = {
      summary: "tidy memories",
      rationale: "trajectory showed drift",
      expectedOutcome: " fewer stale notes",
      edits: [
        { action: "create", kind: "memory", id: "fresh", title: "Fresh", content: "new fact" },
        { action: "update", kind: "memory", id: "keep", title: "Kept", content: "revised fact" },
        { action: "delete", kind: "memory", id: "drop" },
      ],
    };
    const event = await store.applyRefinement(proposal, { scope: "local", source: "manual" });
    expect(event.edits).toHaveLength(3);
    expect(event.edits[0]).toMatchObject({ action: "create", id: "fresh" });
    expect(event.edits[0]?.after).toMatchObject({ version: 1, source: "refine" });
    expect(event.edits[1]?.before).toMatchObject({ content: "content of keep", version: 1 });
    expect(event.edits[1]?.after).toMatchObject({ content: "revised fact", version: 2 });
    expect(event.edits[2]?.before).toMatchObject({ id: "drop" });
    expect(event.edits[2]?.after).toBeUndefined();
    // Applied state.
    expect((await store.get("local", "memory", "keep"))?.content).toBe("revised fact");
    expect(await store.get("local", "memory", "drop")).toBeUndefined();
    expect(await store.get("local", "memory", "fresh")).toMatchObject({ source: "refine" });
    // History: exactly one event, carrying the outcome.
    const history = await store.refinements("local");
    expect(history).toHaveLength(1);
    expect(history[0]?.summary).toBe("tidy memories");
  });

  it("rejects the whole proposal when ANY edit is invalid (no partial apply)", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("keep"));
    const before = await store.snapshot();
    try {
      await store.applyRefinement(
        {
          summary: "mixed bag",
          rationale: "r",
          expectedOutcome: "o",
          edits: [
            { action: "create", kind: "memory", id: "fresh", title: "T", content: "c" },
            { action: "update", kind: "memory", id: "ghost", title: "T", content: "c" },
          ],
        },
        { scope: "local", source: "manual" },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessApplyRejectedError);
      const rejected = error as HarnessApplyRejectedError;
      expect(rejected.issues).toHaveLength(1);
      expect(rejected.issues[0]).toMatchObject({ code: "entry_not_found", id: "ghost" });
    }
    // Nothing — not even the first valid edit — was applied.
    expect((await store.snapshot()).entries).toEqual(before.entries);
    expect(await store.refinements()).toEqual([]);
  });

  it("makes global entries read-only during a local refinement", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("global", memoryInput("shared"));
    await expect(
      store.applyRefinement(
        {
          summary: "s",
          rationale: "r",
          expectedOutcome: "o",
          edits: [{ action: "update", kind: "memory", id: "shared", title: "T", content: "c" }],
        },
        { scope: "local", source: "manual" },
      ),
    ).rejects.toThrow(/entry not found in the local scope: memory:shared/);
    expect((await store.get("global", "memory", "shared"))?.content).toBe("content of shared");
  });

  it("supports same-key edit chains inside one proposal", async () => {
    const store = new InMemoryHarnessStore({ now });
    const event = await store.applyRefinement(
      {
        summary: "chain",
        rationale: "r",
        expectedOutcome: "o",
        edits: [
          { action: "create", kind: "memory", id: "chain", title: "one", content: "v1" },
          { action: "update", kind: "memory", id: "chain", title: "two", content: "v2" },
        ],
      },
      { scope: "local", source: "manual" },
    );
    expect(event.edits).toHaveLength(2);
    expect(event.edits[1]?.before).toMatchObject({ content: "v1" });
    expect((await store.get("local", "memory", "chain"))?.version).toBe(2);
  });
});

describe("rollback", () => {
  it("roundtrips create/update/delete back to the pre-refinement snapshot", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("keep"));
    await store.create("local", memoryInput("drop"));
    const before = await store.snapshot();
    const applied = await store.applyRefinement(
      {
        summary: "mutate everything",
        rationale: "r",
        expectedOutcome: "o",
        edits: [
          { action: "create", kind: "memory", id: "fresh", title: "Fresh", content: "new" },
          { action: "update", kind: "memory", id: "keep", title: "Changed", content: "changed" },
          { action: "delete", kind: "memory", id: "drop" },
        ],
      },
      { scope: "local", source: "manual" },
    );
    const rolledBack = await store.rollback(applied.id);
    expect(rolledBack.rollbackOf).toBe(applied.id);
    expect(rolledBack.source).toBe("rollback");
    // Inverse edits arrive in reverse order: undelete drop, revert keep, delete fresh.
    expect(rolledBack.edits.map((edit) => `${edit.action}:${edit.id}`)).toEqual([
      "create:drop",
      "update:keep",
      "delete:fresh",
    ]);
    const after = await store.snapshot();
    expect(after.entries).toEqual(before.entries);
    expect((await store.get("local", "memory", "drop"))?.version).toBe(1);
    // Rollback events are themselves recorded refinements (upstream parity).
    const history = await store.refinements("local");
    expect(history.map((event) => event.id)).toEqual([applied.id, rolledBack.id]);
  });

  it("names the missing refinement instead of failing silently", async () => {
    const store = new InMemoryHarnessStore({ now });
    await expect(store.rollback("refine_missing")).rejects.toThrow("Refinement 'refine_missing' not found");
  });
});

describe("snapshot / restore / snapshotId", () => {
  async function seededStore() {
    // Deterministic seed state for content-addressed snapshot identity: the
    // seeded refinement event id encodes its apply time, so both seeds must
    // run on the same clock position or they differ before any user edit.
    tick = 1_700_000_000_000;
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", memoryInput("a"));
    await store.create("global", memoryInput("b"));
    await store.applyRefinement(
      {
        summary: "s",
        rationale: "r",
        expectedOutcome: "o",
        edits: [{ action: "update", kind: "memory", id: "a", title: "A", content: "a2" }],
      },
      { scope: "local", source: "manual" },
    );
    return store;
  }

  it("snapshot/restore roundtrips across stores", async () => {
    const store = await seededStore();
    const snapshot = await store.snapshot();
    expect(snapshot.schema).toBe(1);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.refinements).toHaveLength(1);
    const copy = new InMemoryHarnessStore({ now });
    await copy.restore(snapshot);
    expect(await copy.snapshotId()).toBe(await store.snapshotId());
    expect((await copy.snapshot()).entries).toEqual(snapshot.entries);
  });

  it("restore replaces, never merges: stale entries are deleted", async () => {
    const store = await seededStore();
    const snapshot = await store.snapshot();
    await store.create("local", memoryInput("stale"));
    await store.restore(snapshot);
    expect(await store.get("local", "memory", "stale")).toBeUndefined();
    expect(await store.snapshotId()).toBe(await store.snapshotId()); // stable on no-op restore
    const fresh = new InMemoryHarnessStore({ now });
    await fresh.restore(snapshot);
    expect(await store.snapshotId()).toBe(await fresh.snapshotId());
  });

  it("snapshot ids are content-addressed and change with state", async () => {
    const left = await seededStore();
    const right = await seededStore();
    expect(await left.snapshotId()).toBe(await right.snapshotId());
    await right.create("local", memoryInput("extra"));
    expect(await right.snapshotId()).not.toBe(await left.snapshotId());
    expect((await left.snapshotId()).startsWith("sha256:")).toBe(true);
  });
});

describe("optimistic concurrency across writers", () => {
  /** A second store over the SAME adapter simulates a concurrent writer (second tab / host). */
  class PeerStore extends HarnessStoreBase {}

  it("rejects stale-cache writes with a conflict naming the entry, then recovers by re-reading", async () => {
    const adapter = new InMemoryHarnessKvAdapter();
    const first = new PeerStore(adapter, { now });
    const second = new PeerStore(adapter, { now });
    await first.create("local", memoryInput("alpha"));
    await second.list(); // hydrate second's cache
    await first.update("local", "memory", "alpha", { content: "from first" });
    // second's cache is stale: its write carries an expectation the adapter must reject.
    await expect(second.update("local", "memory", "alpha", { content: "from second" })).rejects.toThrow(
      OptimisticConcurrencyError,
    );
    // After the rejection the store rehydrated, so the next write succeeds from truth.
    const retried = await second.update("local", "memory", "alpha", { content: "from second" });
    expect(retried.content).toBe("from second");
    expect(retried.version).toBe(3);
  });

  it("rejects concurrent creates of the same id instead of last-write-wins", async () => {
    const adapter = new InMemoryHarnessKvAdapter();
    const first = new PeerStore(adapter, { now });
    const second = new PeerStore(adapter, { now });
    await second.list();
    await first.create("local", memoryInput("alpha"));
    await expect(second.create("local", memoryInput("alpha"))).rejects.toThrow(/already exists/);
  });
});

describe("adapter protocol", () => {
  it("InMemoryHarnessKvAdapter enforces expectations within one batch", async () => {
    const adapter = new InMemoryHarnessKvAdapter();
    const writes: HarnessKvWrite[] = [
      { type: "put", key: "entry/local/memory/a", value: "one", expectedValue: null },
      { type: "put", key: "entry/local/memory/a", value: "two", expectedValue: "one" },
      { type: "put", key: "entry/local/memory/b", value: "b", expectedValue: null },
    ];
    await adapter.transact(writes);
    const records = await adapter.readAll();
    expect(records).toEqual([
      { key: "entry/local/memory/a", value: "two" },
      { key: "entry/local/memory/b", value: "b" },
    ]);
    // A failed expectation aborts the WHOLE batch (first write included).
    await expect(
      adapter.transact([
        { type: "put", key: "entry/local/memory/c", value: "c" },
        { type: "put", key: "entry/local/memory/a", value: "bad", expectedValue: "stale" },
      ]),
    ).rejects.toThrow(HarnessKvConflictError);
    const after = await adapter.readAll();
    expect(after.find((record) => record.key === "entry/local/memory/c")).toBeUndefined();
    expect(after.find((record) => record.key === "entry/local/memory/a")?.value).toBe("two");
  });

  it("entries serialize one KV record per entry and per refinement event", async () => {
    const adapter = new InMemoryHarnessKvAdapter();
    class PeerStore extends HarnessStoreBase {}
    const store = new PeerStore(adapter, { now });
    await store.create("local", memoryInput("a"));
    await store.applyRefinement(
      {
        summary: "s",
        rationale: "r",
        expectedOutcome: "o",
        edits: [{ action: "create", kind: "prompt", id: "p", title: "P", content: "c" }],
      },
      { scope: "local", source: "manual" },
    );
    const keys = (await adapter.readAll()).map((record) => record.key).sort();
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe("entry/local/memory/a");
    expect(keys[1]).toBe("entry/local/prompt/p");
    expect(keys[2]?.startsWith("refinement/local/refine_")).toBe(true);
    // Event records hold the full snapshot provenance as JSON.
    const eventRecord = JSON.parse(
      (await adapter.readAll()).find((record) => record.key.startsWith("refinement/"))?.value ?? "{}",
    );
    expect(eventRecord.edits[0].after.title).toBe("P");
  });
});

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3] } })).toBe(stableStringify({ a: { c: [3], d: 2 }, b: 1 }));
  });
});
