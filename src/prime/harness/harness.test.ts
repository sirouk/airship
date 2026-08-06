import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERVIEW_CONTENT_LIMIT,
  DEFAULT_OVERVIEW_ENTRY_LIMIT,
  DEFAULT_OVERVIEW_REFINEMENT_LIMIT,
  Harness,
  formatHarnessStateForPrompt,
  mergeHarnessScopes,
} from "./harness";
import type { HarnessCompletionClient, HarnessCompletionRequest } from "./planner";
import {
  HarnessApplyRejectedError,
  HarnessStoreBase,
  InMemoryHarnessStore,
  type HarnessKvAdapter,
  type HarnessKvRecord,
  type HarnessKvWrite,
} from "./store";
import type { HarnessEntry, HarnessRefinementEvent } from "./types";

let tick = 1_700_000_000_000;
const now = () => (tick += 1000);

class StubClient implements HarnessCompletionClient {
  readonly requests: HarnessCompletionRequest[] = [];

  constructor(private readonly replies: string[]) {}

  complete(request: HarnessCompletionRequest) {
    this.requests.push(request);
    const text = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)];
    return Promise.resolve({ stopReason: "stop" as const, text });
  }
}

function memoryEntry(id: string, scope: "local" | "global" = "local", content?: string): HarnessEntry {
  return {
    id,
    kind: "memory",
    title: `Title ${id}`,
    content: content ?? `content of ${id}`,
    path: "general",
    scope,
    source: "agent",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };
}

describe("formatHarnessStateForPrompt projections", () => {
  it("caps entries per kind at 6 with the upstream overflow line", () => {
    const entries = Array.from({ length: 8 }, (_, i) => memoryEntry(`m${i}`));
    const text = formatHarnessStateForPrompt(entries, []);
    expect(text).toContain("memory: 8");
    const shown = text.match(/- \[local:m\d\]/g) ?? [];
    expect(shown).toHaveLength(DEFAULT_OVERVIEW_ENTRY_LIMIT);
    expect(text).toContain(`- +${8 - DEFAULT_OVERVIEW_ENTRY_LIMIT} more memory entries`);
  });

  it("truncates bodies at 180 chars and tags scopes", () => {
    const longBody = "word ".repeat(100).trim(); // 499 chars
    const entries = [memoryEntry("long", "global", longBody)];
    const text = formatHarnessStateForPrompt(entries, []);
    const bodyLine = text.split("\n").find((line) => line.includes("[global:long]"));
    expect(bodyLine).toBeDefined();
    expect(bodyLine).toContain("...");
    expect((bodyLine ?? "").length).toBeLessThan(240);
    expect(bodyLine).toContain("(general, v1)");
  });

  it("caps refinement events at 5 newest with an overflow line and change summaries", () => {
    const events: HarnessRefinementEvent[] = Array.from({ length: 7 }, (_, i) => ({
      id: `refine_${i}`,
      summary: `summary ${i}`,
      rationale: "r",
      expectedOutcome: "o",
      edits: [{ action: "create" as const, kind: "memory" as const, id: `x${i}` }],
      scope: "local" as const,
      source: "manual" as const,
      appliedAt: i,
    }));
    const text = formatHarnessStateForPrompt([], events);
    expect(text).toContain("recent refinements: 7");
    expect(text).toContain(`- +${7 - DEFAULT_OVERVIEW_REFINEMENT_LIMIT} older refinement events`);
    expect(text).not.toContain("[refine_0]");
    expect(text).not.toContain("[refine_1]");
    expect(text).toContain("[refine_6] summary 6: create memory:x6; outcome: o");
  });

  it("uses the IPython-free call contract by default in this build", () => {
    const text = formatHarnessStateForPrompt([], []);
    expect(text).toContain("sessions without IPython or shell access");
    expect(text).not.toContain("await rlm.list_subagents()");
    expect(text).toContain("No saved harness entries yet.");
  });
});

describe("mergeHarnessScopes", () => {
  it("local shadows global for the same kind:id", () => {
    const merged = mergeHarnessScopes([memoryEntry("shared", "global", "g"), memoryEntry("shared", "local", "l")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ scope: "local", content: "l" });
    // Unshadowed globals survive.
    const both = mergeHarnessScopes([memoryEntry("only-global", "global"), memoryEntry("only-local", "local")]);
    expect(both.map((entry) => entry.id).sort()).toEqual(["only-global", "only-local"]);
  });
});

describe("Harness facade", () => {
  it("renders the merged store into the system-prompt projection", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("global", { id: "g", kind: "memory", title: "G", content: "global fact" });
    await store.create("local", { id: "l", kind: "skill", title: "L", content: "local skill", reference: { type: "python", import: "m", callable: "f" }, arguments: {} });
    const harness = new Harness(store);
    const text = await harness.formatForPrompt();
    expect(text).toContain("[global:g] G");
    expect(text).toContain("[local:l] L");
    expect(text).toContain("memory: 1");
    expect(text).toContain("skill: 1");
  });

  it("caps the overview as data", async () => {
    const store = new InMemoryHarnessStore({ now });
    for (let i = 0; i < 3; i += 1) {
      await store.create("local", { id: `m${i}`, kind: "memory", title: `m${i}`, content: "c" });
    }
    const overview = await new Harness(store).overview();
    expect(overview.counts).toEqual({ prompt: 0, memory: 3, skill: 0, subagent: 0 });
    expect(overview.caps).toEqual({
      entriesPerKind: DEFAULT_OVERVIEW_ENTRY_LIMIT,
      refinementEvents: DEFAULT_OVERVIEW_REFINEMENT_LIMIT,
      contentChars: DEFAULT_OVERVIEW_CONTENT_LIMIT,
    });
  });

  it("normalizes local:/global: id prefixes across facade CRUD", async () => {
    const harness = new Harness(new InMemoryHarnessStore({ now }));
    await harness.createEntry("global", { id: "shared", kind: "memory", title: "S", content: "c" });
    // A bare local lookup misses; the global: prefix routes to the right store.
    expect(await harness.getEntry("local", "memory", "shared")).toBeUndefined();
    expect(await harness.getEntry("local", "memory", "global:shared")).toMatchObject({ scope: "global" });
    await harness.updateEntry("local", "memory", "global:shared", { content: "via prefix" });
    expect((await harness.getEntry("global", "memory", "shared"))?.content).toBe("via prefix");
    await harness.deleteEntry("global", "memory", "shared");
    expect(await harness.deleteEntry("local", "memory", "global:shared")).toBe(false);
  });

  it("records snapshots only on refine-applied edits, never on direct edits", async () => {
    const store = new InMemoryHarnessStore({ now });
    const harness = new Harness(store);
    await harness.createEntry("local", { id: "d", kind: "memory", title: "D", content: "direct" });
    await harness.updateEntry("local", "memory", "d", { content: "direct v2" });
    // Direct edits: source "agent", no refinement history. (Upstream parity.)
    expect(await store.refinements()).toEqual([]);
    expect((await harness.getEntry("local", "memory", "d"))?.source).toBe("agent");

    const event = await harness.proposeAndApply(
      {
        summary: "refined",
        rationale: "r",
        expectedOutcome: "o",
        edits: [{ action: "update", kind: "memory", id: "d", title: "D", content: "refined v3" }],
      },
      { scope: "local" },
    );
    expect(event.edits[0]?.before).toMatchObject({ content: "direct v2", version: 2 });
    expect(event.edits[0]?.after).toMatchObject({ content: "refined v3", version: 3 });
    expect((await harness.getEntry("local", "memory", "d"))?.source).toBe("refine");
    expect(await store.refinements("local")).toHaveLength(1);
  });

  it("rejects invalid proposals with all issues and writes nothing", async () => {
    const harness = new Harness(new InMemoryHarnessStore({ now }));
    await expect(
      harness.proposeAndApply(
        {
          summary: "s",
          rationale: "r",
          expectedOutcome: "o",
          edits: [
            { action: "create", kind: "memory", id: "ok", title: "T", content: "c" },
            { action: "delete", kind: "memory", id: "ghost" },
            { action: "update", kind: "memory", id: "also-ghost", title: "T", content: "c" },
          ],
        },
        { scope: "local" },
      ),
    ).rejects.toThrow(HarnessApplyRejectedError);
    expect(await harness.listEntries()).toEqual([]);
  });

  it("restores the pre-apply snapshot when the apply fails mid-flight (rollback-on-failure)", async () => {
    // Adapter that writes the first record of each batch, then dies: the worst
    // partial apply the facade's defensive restore exists for.
    class PartiallyFailingAdapter implements HarnessKvAdapter {
      private readonly records = new Map<string, string>();
      failNext = false;

      readAll(): Promise<readonly HarnessKvRecord[]> {
        return Promise.resolve([...this.records.entries()].map(([key, value]) => ({ key, value })));
      }

      transact(writes: readonly HarnessKvWrite[]): Promise<void> {
        if (!this.failNext) {
          for (const write of writes) {
            if (write.type === "put") this.records.set(write.key, write.value);
            else this.records.delete(write.key);
          }
          return Promise.resolve();
        }
        this.failNext = false;
        const first = writes[0];
        if (first) {
          if (first.type === "put") this.records.set(first.key, first.value);
          else this.records.delete(first.key);
        }
        return Promise.reject(new Error("storage exploded mid-batch"));
      }
    }
    class TestStore extends HarnessStoreBase {}
    const adapter = new PartiallyFailingAdapter();
    const store = new TestStore(adapter, { now });
    const harness = new Harness(store);
    await harness.createEntry("local", { id: "keep", kind: "memory", title: "K", content: "stable" });
    const snapshotIdBefore = await harness.snapshotId();
    adapter.failNext = true;
    await expect(
      harness.proposeAndApply(
        {
          summary: "doomed",
          rationale: "r",
          expectedOutcome: "o",
          edits: [
            { action: "create", kind: "memory", id: "new", title: "N", content: "c" },
            { action: "update", kind: "memory", id: "keep", title: "K", content: "changed" },
          ],
        },
        { scope: "local" },
      ),
    ).rejects.toThrow("storage exploded mid-batch");
    // The partially written "new" record must be gone; state bytes unchanged.
    expect(await harness.listEntries()).toHaveLength(1);
    expect(await harness.snapshotId()).toBe(snapshotIdBefore);
    // And the store did not wedge: ordinary writes still work.
    await harness.createEntry("local", { id: "after", kind: "memory", title: "A", content: "c" });
    expect((await harness.listEntries()).map((entry) => entry.id).sort()).toEqual(["after", "keep"]);
  });

  it("autoRefine skips when the review gate says no, and records nothing", async () => {
    const store = new InMemoryHarnessStore({ now });
    const harness = new Harness(store);
    const client = new StubClient(['{"shouldRefine": false, "rationale": "one-off failure, not a pattern"}']);
    const result = await harness.autoRefine({
      trajectorySlice: "single transient crash",
      context: { reason: "turn_interval", turnsSinceLastReview: 25 },
      client,
      modelMaxOutputTokens: 128_000,
    });
    expect(result).toEqual({ status: "skipped", review: { shouldRefine: false, rationale: "one-off failure, not a pattern" } });
    // The refine pass was never even planned: exactly one completion (the gate).
    expect(client.requests).toHaveLength(1);
    expect(await store.refinements()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("autoRefine plans + applies on gate approval and records the event as auto", async () => {
    const store = new InMemoryHarnessStore({ now });
    const harness = new Harness(store);
    const client = new StubClient([
      '{"shouldRefine": true, "rationale": "twice failing command", "instructions": "record it"}',
      JSON.stringify({
        summary: "memorize the failing command",
        rationale: "seen twice",
        expectedOutcome: "remembered",
        edits: [{ action: "create", kind: "memory", id: "failing_cmd", title: "Failing cmd", content: "use --project build" }],
      }),
    ]);
    const result = await harness.autoRefine({
      trajectorySlice: "npx tsc failed twice",
      context: { reason: "compact", turnsSinceLastReview: 4 },
      client,
      modelMaxOutputTokens: 128_000,
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.event.source).toBe("auto");
      expect(result.review.shouldRefine).toBe(true);
    }
    expect(client.requests).toHaveLength(2);
    const saved = await store.get("local", "memory", "failing_cmd");
    expect(saved).toMatchObject({ source: "refine", version: 1 });
    expect(await store.refinements("local")).toHaveLength(1);
  });

  it("refine() plans and applies in one call with the plan baseline forwarded", async () => {
    const store = new InMemoryHarnessStore({ now });
    await store.create("local", { id: "x", kind: "memory", title: "X", content: "old" });
    const harness = new Harness(store);
    const client = new StubClient([
      JSON.stringify({
        summary: "update x",
        rationale: "r",
        expectedOutcome: "o",
        edits: [{ action: "update", kind: "memory", id: "x", title: "X", content: "new" }],
      }),
    ]);
    const event = await harness.refine({ trajectorySlice: "t", client, modelMaxOutputTokens: 128_000 });
    expect(event.source).toBe("manual");
    expect((await harness.getEntry("local", "memory", "x"))?.content).toBe("new");
  });
});
