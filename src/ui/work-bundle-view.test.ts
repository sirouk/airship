import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planSentence, resultSentence, untouchedSentence, WORK_BUNDLE_AUTHORITY_UNSETTLED } from "./work-bundle-view";
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
    // The count names both reasons a conversation is refused as a conflict —
    // a different conversation under that id, and one the file addresses to
    // another profile — and the row beside each says which.
    expect(sentence).toContain("1 will be refused: different work under that id, or another profile's.");
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
      memory: Object.freeze({ offered: 3, add: 2, present: 1, conflict: 0, overflow: 0, foreign: 0 }),
    }))).toContain("Memory: 3 records offered, 2 new, 1 already present. Memory is added only if you ask for it.");
  });

  it("names what is left alone, including the key a bundle is not", () => {
    const untouched = untouchedSentence(plan({ untouchedConversations: 4 }));
    expect(untouched).toContain("4 conversations already here");
    expect(untouched).toContain("your memory records");
    expect(untouched).toContain("your workspace files");
    expect(untouched).toContain("your Vault key");
    expect(untouchedSentence(plan())).toContain("no other conversation is here");
    // Memory travelling is not enough: it is untouched until the person asks.
    const withMemory = plan({ memory: Object.freeze({ offered: 1, add: 1, present: 0, conflict: 0, overflow: 0, foreign: 0 }) });
    expect(untouchedSentence(withMemory)).toContain("your memory records");
    expect(untouchedSentence(withMemory, true)).not.toContain("your memory records");
  });

  it("reports the outcome in the same vocabulary as the plan", () => {
    const result: WorkBundleImportResult = Object.freeze({
      conversations: Object.freeze([]),
      imported: 2,
      skipped: 1,
      refused: 1,
      memory: Object.freeze({ added: 3, present: 1, conflict: 1, overflow: 0, foreign: 2 }),
    });
    expect(resultSentence(result)).toBe(
      "2 conversations added. 1 skipped as already present. 1 refused and left alone."
      + " Memory: 3 records added, 1 already present, 3 refused.",
    );
  });
});

/*
 * F2(b), second half. The panel decided for the person: `includeMemory` was
 * `Boolean(incoming.bundle.memory && workspace)` — true whenever the file
 * happened to carry records — while the only control on screen said
 * "Add N conversations". Asserted against the module's own source for the
 * reason `connection-continuity.test.ts` states: this is a wiring contract
 * between a control and a call, and a renderer-free assertion on the call is
 * what keeps the two from drifting apart again.
 */
describe("bringing memory in is a decision the person makes", () => {
  const source = readFileSync(new URL("./work-bundle-view.tsx", import.meta.url), "utf8");

  it("passes the checkbox to the import rather than the presence of records", () => {
    expect(source).toContain("includeMemory: addMemory");
    expect(source).not.toContain("includeMemory: Boolean(incoming.bundle.memory");
    // Unchecked on every file, including a second one inspected after a first.
    expect(source).toContain("const [addMemory, setAddMemory] = useState(false);");
    expect(source).toContain("setAddMemory(false);");
  });

  it("names the memory records on the button that adds them", () => {
    expect(source).toContain("` and ${String(addableMemory)} memory records`");
    expect(source).toContain("const addableMemory = addMemory ? offeredMemory?.add ?? 0 : 0;");
  });

  it("imports memory into the profile this panel names, and no other", () => {
    expect(source).toContain("planWorkBundleImport({ bundle, journal, chain, workspace, profileId })");
    expect(source).toContain("profileId,\n        includeMemory: addMemory,");
  });
});

/*
 * P1. The first thing a person does on a new device, and the exact job this
 * feature exists for.
 *
 * Measured in Chromium with a Local Device Vault enrolled: the page-memory
 * runtime boots first, adoption reads that journal and then replaces it, and an
 * import that lands inside that window is written into the journal being
 * replaced. The panel reported "1 conversation added.", the list held the row
 * at t+3ms, and after the adoption, after Refresh and after a reload the row
 * was gone — with nothing anywhere admitting a loss.
 *
 * The fix is a gate on the same settled-authority latch the chat route waits
 * for before it answers for an address, and it refuses rather than queues: a
 * queued import would run against a journal nobody has looked at since, and the
 * file is still on disk to choose again.
 */
describe("an import waits for the journal it is writing into", () => {
  const source = readFileSync(new URL("./work-bundle-view.tsx", import.meta.url), "utf8");

  it("says why it is unavailable, and that it refused rather than queued", () => {
    expect(WORK_BUNDLE_AUTHORITY_UNSETTLED).toContain("still opening the storage");
    expect(WORK_BUNDLE_AUTHORITY_UNSETTLED).toContain("about to replace");
    expect(WORK_BUNDLE_AUTHORITY_UNSETTLED).toContain("refused rather than queued");
    expect(WORK_BUNDLE_AUTHORITY_UNSETTLED).toContain("Nothing changed");
    expect(WORK_BUNDLE_AUTHORITY_UNSETTLED).toContain("choose the file again");
    // A refusal is not a queue. Nothing here may promise a later retry.
    expect(WORK_BUNDLE_AUTHORITY_UNSETTLED).not.toMatch(/queued for|will be added|retry automatically/u);
  });

  it("gates the import action itself, before anything is read or written", () => {
    // The refusal is the first thing `runImport` does, ahead of `setBusy`.
    expect(source).toContain("if (!authoritySettled) {\n      setError(WORK_BUNDLE_AUTHORITY_UNSETTLED);\n      return;\n    }");
    expect(source.indexOf("setError(WORK_BUNDLE_AUTHORITY_UNSETTLED)"))
      .toBeLessThan(source.indexOf("const { migrateJournalState } = await loadDeferredCapabilities();"));
    // And the control says so before it is pressed.
    expect(source).toContain("disabled={busy || !authoritySettled || (importable === 0 && addableMemory === 0)}");
    expect(source).toContain('? "Waiting for this storage"');
    expect(source).toContain("{authoritySettled ? null : <p class=\"work-bundle__refused\">{WORK_BUNDLE_AUTHORITY_UNSETTLED}</p>}");
  });

  it("leaves taking work out alone, because an export writes nothing", () => {
    const exportBody = source.slice(source.indexOf("async function exportBundle"), source.indexOf("async function inspect"));
    expect(exportBody).not.toContain("authoritySettled");
    const inspectBody = source.slice(source.indexOf("async function inspect"), source.indexOf("async function runImport"));
    expect(inspectBody).not.toContain("authoritySettled");
  });
});
