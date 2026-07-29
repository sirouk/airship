import { describe, expect, it } from "vitest";
import { mostConnectedNodes } from "./memory-view";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryNodeKind, MemoryRelationshipGraph } from "../memory-graph";

/**
 * The graph inspector's empty state is a launcher, not a placeholder — it
 * offers the nodes a person is most likely to want first. What it must never
 * do is offer one the canvas is not drawing: the whole reason `term` starts
 * hidden is that 92% of a real graph was unlabelled derived terms, and a
 * launcher that selected one would move the highlight to nothing visible.
 */
describe("most connected nodes", () => {
  it("ranks by degree and never offers a node the canvas is hiding", () => {
    const graph = stubGraph([
      node("session-1", "General session", "session"),
      node("term-1", "workspace", "term"),
      node("file-1", "README.md", "workspace-file"),
    ], [
      edge("e1", "session-1", "term-1"),
      edge("e2", "session-1", "file-1"),
      edge("e3", "term-1", "file-1"),
    ]);

    const visible = mostConnectedNodes(graph, new Set<MemoryNodeKind>(["term"]));
    expect(visible.map((entry) => entry.id)).toEqual(["session-1", "file-1"]);
    // Degree still counts the hidden neighbour: the picture is filtered, the
    // memory is not, and the number has to keep saying so.
    expect(visible[0]).toMatchObject({ degree: 2, kind: "session", label: "General session" });

    const unfiltered = mostConnectedNodes(graph, new Set<MemoryNodeKind>());
    expect(unfiltered).toHaveLength(3);

    // An individually hidden node is hidden for the same reason a hidden kind
    // is: the canvas is not drawing it, so the launcher must not offer it.
    expect(mostConnectedNodes(graph, new Set<MemoryNodeKind>(), new Set(["session-1"])).map((entry) => entry.id))
      .toEqual(["file-1", "term-1"]);
  });

  it("breaks degree ties by label so the list does not reshuffle on rerender", () => {
    const graph = stubGraph([
      node("b", "Beta", "profile"),
      node("a", "Alpha", "profile"),
      node("hub", "Hub", "session"),
    ], [edge("e1", "hub", "a"), edge("e2", "hub", "b")]);
    expect(mostConnectedNodes(graph, new Set<MemoryNodeKind>()).map((entry) => entry.label))
      .toEqual(["Hub", "Alpha", "Beta"]);
  });

  it("honours the limit and freezes what it returns", () => {
    const graph = stubGraph(
      Array.from({ length: 9 }, (_, index) => node(`n${index}`, `Node ${index}`, "skill")),
      [],
    );
    const top = mostConnectedNodes(graph, new Set<MemoryNodeKind>(), new Set(), 5);
    expect(top).toHaveLength(5);
    expect(Object.isFrozen(top)).toBe(true);
    expect(Object.isFrozen(top[0])).toBe(true);
  });
});

function node(id: string, label: string, kind: MemoryNodeKind): MemoryGraphNode {
  return { id, kind, label, key: id, summary: "", metadata: {}, size: 4, color: "#fff", x: 0, y: 0 };
}

function edge(id: string, source: string, target: string): MemoryGraphEdge {
  return { id, kind: "mentions", source, target, directed: false, weight: 1, label: "mentions", metadata: {} };
}

/** Only the three members `mostConnectedNodes` reads; the rest would be noise. */
function stubGraph(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): MemoryRelationshipGraph {
  return {
    nodes,
    getIncidentEdges: (id: string) => edges.filter((item) => item.source === id || item.target === id),
  } as unknown as MemoryRelationshipGraph;
}
