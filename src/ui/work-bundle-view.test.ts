import { describe, expect, it } from "vitest";
import { planSentence, resultSentence, untouchedSentence } from "./work-bundle-view";
import type { WorkBundleImportPlan, WorkBundleImportResult } from "../sessions/work-bundle";

function plan(overrides: Partial<WorkBundleImportPlan> = {}): WorkBundleImportPlan {
  return Object.freeze({
    exportedAt: "2026-08-21T09:00:00.000Z",
    conversations: Object.freeze([]),
    untouchedConversations: 0,
    ...overrides,
  }) as WorkBundleImportPlan;
}

function entry(state: "new" | "present" | "conflict" | "unreadable", id: string) {
  return Object.freeze({ sessionId: id, title: id, events: 2, state });
}

describe("what the move-work panel says before it writes anything", () => {
  it("states the count, the additions, the skips and the refusals", () => {
    const sentence = planSentence(plan({
      conversations: Object.freeze([
        entry("new", "a"),
        entry("present", "b"),
        entry("conflict", "c"),
        entry("unreadable", "d"),
      ]),
    }));
    expect(sentence).toContain("This bundle holds 4 conversations.");
    expect(sentence).toContain("1 will be added.");
    expect(sentence).toContain("1 is already here and will be skipped.");
    expect(sentence).toContain("1 will be refused: this journal holds different work under the same id.");
    expect(sentence).toContain("1 will be refused: the digest chain did not verify.");
  });

  it("says nothing about skips or refusals when there are none", () => {
    const sentence = planSentence(plan({ conversations: Object.freeze([entry("new", "a")]) }));
    expect(sentence).toBe("This bundle holds 1 conversation. 1 will be added.");
  });

  /*
   * The memory line is only present when memory is actually in the file AND a
   * workspace exists to merge it into. A count of zero would read as "your
   * memory was considered", which is a claim about work that never happened.
   */
  it("adds a memory line only when memory travels", () => {
    expect(planSentence(plan({ conversations: Object.freeze([entry("new", "a")]) }))).not.toContain("Memory:");
    expect(planSentence(plan({
      conversations: Object.freeze([entry("new", "a")]),
      memory: Object.freeze({ offered: 3, add: 2, present: 1, conflict: 0, overflow: 0 }),
    }))).toContain("Memory: 3 records offered, 2 new, 1 already present.");
  });

  it("names what is left alone, including the key a bundle is not", () => {
    const untouched = untouchedSentence(plan({ untouchedConversations: 4 }));
    expect(untouched).toContain("4 conversations already here");
    expect(untouched).toContain("your memory records");
    expect(untouched).toContain("your workspace files");
    expect(untouched).toContain("your Vault key");
    expect(untouchedSentence(plan())).toContain("no other conversation is here");
    // Memory travelling means memory is no longer in the untouched list.
    expect(untouchedSentence(plan({
      memory: Object.freeze({ offered: 1, add: 1, present: 0, conflict: 0, overflow: 0 }),
    }))).not.toContain("your memory records");
  });

  it("reports the outcome in the same vocabulary as the plan", () => {
    const result: WorkBundleImportResult = Object.freeze({
      conversations: Object.freeze([]),
      imported: 2,
      skipped: 1,
      refused: 1,
      memory: Object.freeze({ added: 3, present: 1, conflict: 1, overflow: 0 }),
    });
    expect(resultSentence(result)).toBe(
      "2 conversations added. 1 skipped as already present. 1 refused and left alone."
      + " Memory: 3 records added, 1 already present, 1 refused.",
    );
  });
});
