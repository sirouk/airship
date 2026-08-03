import { describe, expect, it } from "vitest";
import { memoryStarters, type MemoryRecordEntry } from "./memory-view";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryNodeKind, MemoryRelationshipGraph } from "../memory-graph";
import type { WorkspaceEntry } from "../workspace/contracts";

/**
 * A suggestion is a claim about the corpus.
 *
 * The unsearched Memory route used to be three empty boxes and the sentence
 * "Ready for a private on-device query." — accurate, and with nothing in it to
 * press. Starters make that state actionable, which is only honest if every
 * term is read out of live page state at render time and every button says
 * which surface it came from. These tests exist to stop a starter from ever
 * becoming a guess or a hardcoded example — and, since the measured defect,
 * from naming a lane that cannot answer it.
 */
describe("memory starters", () => {
  it("takes terms from the indexed sources, the profile's own records and the graph, and names each origin", () => {
    const starters = memoryStarters(
      [entry("/workspace/notes/retrieval.md"), entry("/workspace/README.md")],
      [record("lab-notes")],
      stubGraph([node("s1", "General session", "session")], []),
    );

    expect(starters.map((starter) => starter.term)).toEqual([
      "retrieval",
      "README",
      "lab-notes",
      "General session",
    ]);
    expect(starters.map((starter) => starter.origin)).toEqual([
      "workspace source",
      "workspace source",
      "active profile memory",
      "most connected session",
    ]);
  });

  /*
   * The defect this file is now the guard for: the strip offered the active
   * profile's *name* under the origin "active profile", and the Active profile
   * memory lane returned "No memory matched “General”" every single time,
   * because a profile name is in no corpus. A profile term may only come from a
   * record the profile actually holds.
   */
  it("never mints a term from the profile's name, which no lane searches", () => {
    const starters = memoryStarters([], [], stubGraph([], []));
    expect(starters).toEqual([]);
    const withRecords = memoryStarters([], [record("kyoto-trial")], stubGraph([], []));
    expect(withRecords.map((starter) => starter.term)).toEqual(["kyoto-trial"]);
  });

  it("offers the newest record's source first, because that is what a person just wrote", () => {
    const starters = memoryStarters([], [record("older"), record("newest")], stubGraph([], []));
    expect(starters.map((starter) => starter.term)).toEqual(["newest", "older"]);
  });

  it("never repeats a term, whatever the surface it came from", () => {
    const starters = memoryStarters(
      [entry("/workspace/general.md")],
      [record("general")],
      stubGraph([node("s1", "general", "session")], []),
    );
    expect(starters).toHaveLength(1);
    expect(starters[0]).toMatchObject({ term: "general", origin: "workspace source" });
  });

  it("refuses a term too long to sit on a 44px chip rather than truncating a claim", () => {
    const long = "x".repeat(64);
    const starters = memoryStarters([entry(`/workspace/${long}.md`)], [record("lab-notes")], stubGraph([], []));
    expect(starters.map((starter) => starter.term)).toEqual(["lab-notes"]);
  });

  it("returns nothing when the page holds nothing, so no button offers an empty search", () => {
    expect(memoryStarters([], [], stubGraph([], []))).toEqual([]);
  });

  it("honours the limit and freezes what it returns", () => {
    const files = Array.from({ length: 9 }, (_, index) => entry(`/workspace/file-${index}.md`));
    const starters = memoryStarters(files, [record("lab-notes")], stubGraph([], []), 3);
    expect(starters).toHaveLength(3);
    expect(Object.isFrozen(starters)).toBe(true);
    expect(Object.isFrozen(starters[0])).toBe(true);
  });
});

function entry(path: string): WorkspaceEntry {
  return { path, kind: "file", size: 12, revision: "r1", updatedAt: "2026-07-27T10:00:00.000Z" } as unknown as WorkspaceEntry;
}

function record(source: string): MemoryRecordEntry {
  return { id: `id-${source}`, content: `content for ${source}`, source, createdAt: "2026-07-27T10:00:00.000Z" };
}

function node(id: string, label: string, kind: MemoryNodeKind): MemoryGraphNode {
  return { id, kind, label, key: id, summary: "", metadata: {}, size: 4, color: "#fff", x: 0, y: 0 };
}

/** Only the two members the starter list reads; the rest would be noise. */
function stubGraph(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): MemoryRelationshipGraph {
  return {
    nodes,
    getIncidentEdges: (id: string) => edges.filter((item) => item.source === id || item.target === id),
  } as unknown as MemoryRelationshipGraph;
}
