import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  planSentence,
  resultSentence,
  untouchedSentence,
  WORK_BUNDLE_AUTHORITY_UNSETTLED,
  WORK_BUNDLE_PLAN_SUPERSEDED,
} from "./work-bundle-view";
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

/*
 * F6. The refusal above says "choose the file again once it is open", and until
 * now that is not what happened.
 *
 * Measured with a Local Device Vault configured: a bundle chosen while the page
 * was still opening that Vault was planned against the page-memory journal, so
 * the panel said "4 will be added" — and kept saying it for the eight seconds
 * the adoption took, after which the button enabled itself against a different
 * journal. Pressing it then reported "0 conversations added. 4 skipped as
 * already present." Nothing was lost, and nothing was overwritten; the panel
 * had simply stated an outcome that could not happen and then contradicted it.
 *
 * The fact that decides whether a plan still describes anything is the journal
 * it would be merged into, not the settled-authority latch — so the panel
 * compares the journal it planned against with the journal it now holds, and
 * withdraws a plan that is about the other one.
 */
describe("a plan is about one journal, and says so when that journal is replaced", () => {
  const source = readFileSync(new URL("./work-bundle-view.tsx", import.meta.url), "utf8");

  it("says what was withdrawn, that nothing changed, and the one remedy", () => {
    expect(WORK_BUNDLE_PLAN_SUPERSEDED).toContain("finished opening");
    expect(WORK_BUNDLE_PLAN_SUPERSEDED).toContain("the journal it replaced");
    expect(WORK_BUNDLE_PLAN_SUPERSEDED).toContain("Nothing changed and nothing was added");
    expect(WORK_BUNDLE_PLAN_SUPERSEDED).toContain("choose the file again");
    // The remedy the sentence above promises is the remedy this one performs,
    // so neither may promise a retry nobody will run.
    expect(WORK_BUNDLE_PLAN_SUPERSEDED).not.toMatch(/queued for|will be added|retry automatically/u);
  });

  it("records the journal a plan was read against, and compares it every render", () => {
    expect(source).toContain("const plannedJournal = useRef<JournalStateSource>();");
    expect(source).toContain("plannedJournal.current = journal;");
    expect(source).toContain("const supersededPlan = incoming !== undefined && plannedJournal.current !== journal;");
    // Derived, not latched: there is no frame in which the stale plan is on
    // screen beside a button that has just enabled itself.
    expect(source).not.toContain("setSupersededPlan");
  });

  it("withdraws the plan from the screen and from the action", () => {
    expect(source).toContain("{supersededPlan ? (\n            <p class=\"work-bundle__refused\" role=\"alert\">{WORK_BUNDLE_PLAN_SUPERSEDED}</p>\n          ) : incoming ? (");
    // And the plan's own narration goes with it, so the two live regions in
    // this panel cannot contradict each other about the same file.
    expect(source).toContain('<p class="work-bundle__status" role="status">{supersededPlan ? "" : announcement}</p>');
    const runImport = source.slice(source.indexOf("async function runImport"), source.indexOf("const supersededPlan ="));
    expect(runImport).toContain("if (supersededPlan) {\n      setIncoming(undefined);\n      setError(WORK_BUNDLE_PLAN_SUPERSEDED);\n      return;\n    }");
    // The storage gate stays exactly where it was, ahead of this one.
    expect(runImport.indexOf("WORK_BUNDLE_AUTHORITY_UNSETTLED")).toBeLessThan(runImport.indexOf("WORK_BUNDLE_PLAN_SUPERSEDED"));
  });
});

/*
 * P1. "Select all" is this panel's one claim about the whole list, and it was
 * the one control in it that could not keep that claim.
 *
 * Found by a documentation auditor as an intermittent failure of
 * `e2e/bundle-grants-no-approval-mode.spec.ts`, and reproduced deterministically
 * in `e2e/move-work-select-all.spec.ts`: the handler committed
 * `conversations.map(...)` — the rows visible at the instant of the press. This
 * panel is a lazily fetched chunk and the sessions route's journal read is not,
 * so on a warm cache the panel is on screen while the read is still in flight.
 * Pressed there, "Select all" committed the empty list; the rows then arrived
 * unticked, the legend read "Conversations (0 of 1)", "Write bundle file" stayed
 * disabled, and nothing said why.
 *
 * These are guards on the shape, in the fast suite. The proof that the race is
 * gone is the browser spec, which presses the control against a held journal
 * read and then releases it.
 */
describe("select all means all, whenever it is pressed", () => {
  const source = readFileSync(new URL("./work-bundle-view.tsx", import.meta.url), "utf8");

  it("restores the everything rule rather than copying the rows on screen", () => {
    expect(source).toContain("onClick={() => setChosen(undefined)}");
    // The copy is the defect. No spelling of it may come back.
    expect(source).not.toContain("setChosen(conversations.map(");
    // `undefined` is only "everything" because this line reads it that way.
    expect(source).toContain("const selected = chosen ?? conversations.map((row) => row.id);");
  });

  it("leaves Clear committing the empty list, because empty is what Clear means", () => {
    expect(source).toContain("onClick={() => setChosen([])}");
  });

  it("does not report a read still in flight as an empty journal", () => {
    expect(source).toContain("conversationsSettled: boolean;");
    expect(source).toContain('? "There is nothing here to take out yet."');
    expect(source).toContain(': "Still reading the conversations on this device."');
  });
});
