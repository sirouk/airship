import { describe, expect, it } from "vitest";
import { deriveMemoryRelationshipGraph, memoryNodeId, stableMemoryContentHash } from "./derive";
import type { MemoryGraphInput } from "./types";

const relationshipFixture: MemoryGraphInput = {
  profiles: [
    { id: "engineer", name: "Systems Engineer", role: "Build and operate", skillIds: ["workspace-steward"] },
    { id: "reviewer", name: "Security Reviewer", role: "Verify trust claims" },
  ],
  skills: [
    {
      id: "workspace-steward",
      name: "Workspace Steward",
      description: "Inspect and update workspace files safely.",
      profileIds: ["engineer"],
      sourcePaths: ["docs/guide.md"],
    },
  ],
  workspaceFiles: [
    { path: "README.md", content: "Start with docs/guide.md.", revision: "rev-a", size: 24 },
    { path: "docs/guide.md", content: "Security Reviewer policy.", revision: "rev-b", size: 25 },
  ],
  sessions: [
    {
      id: "session-a",
      title: "Workspace audit",
      profileId: "engineer",
      skillIds: ["workspace-steward"],
      messages: [
        {
          id: "message-a",
          role: "user",
          content: "Read README.md using Workspace Steward.",
          filePaths: ["README.md"],
          skillIds: ["workspace-steward"],
        },
        {
          id: "message-b",
          role: "assistant",
          content: "I will inspect docs/guide.md with the Security Reviewer.",
          profileId: "reviewer",
        },
      ],
    },
  ],
};

describe("deriveMemoryRelationshipGraph", () => {
  it("memoizes by stable content rather than input array identity", () => {
    const first = deriveMemoryRelationshipGraph(structuredClone(relationshipFixture));
    const second = deriveMemoryRelationshipGraph(structuredClone(relationshipFixture));
    expect(second).toBe(first);
  });
  it("uses a deterministic bounded content hash key", () => {
    expect(stableMemoryContentHash("same")).toBe(stableMemoryContentHash("same"));
    expect(stableMemoryContentHash("same")).not.toBe(stableMemoryContentHash("different"));
    expect(stableMemoryContentHash("x".repeat(10_000)).length).toBeLessThan(32);
  });
  it("derives deterministic nodes and explicit relationships from real inputs", () => {
    const first = deriveMemoryRelationshipGraph(relationshipFixture);
    const second = deriveMemoryRelationshipGraph(relationshipFixture);
    const reordered = deriveMemoryRelationshipGraph({
      ...relationshipFixture,
      profiles: [...relationshipFixture.profiles!].reverse(),
      skills: [...relationshipFixture.skills!].reverse(),
      workspaceFiles: [...relationshipFixture.workspaceFiles!].reverse(),
      sessions: [...relationshipFixture.sessions!].reverse(),
    });

    expect(first.revision).toBe(second.revision);
    expect(first.revision).toBe(reordered.revision);
    expect(first.nodes).toEqual(second.nodes);
    expect(first.nodes).toEqual(reordered.nodes);
    expect(first.stats.nodeKinds.session).toBe(1);
    expect(first.stats.nodeKinds.message).toBe(2);
    expect(first.stats.nodeKinds["workspace-file"]).toBe(2);
    expect(first.stats.nodeKinds.profile).toBe(2);
    expect(first.stats.nodeKinds.skill).toBe(1);
    expect(first.stats.nodeKinds.term).toBeGreaterThan(0);
    expect(first.stats.edgeKinds.contains).toBe(2);
    expect(first.stats.edgeKinds.follows).toBe(1);

    const sessionId = memoryNodeId("session", "session-a");
    const sessionNeighbors = first.getNeighbors(sessionId);
    expect(sessionNeighbors.some((node) => node.id === memoryNodeId("profile", "engineer"))).toBe(true);
    expect(sessionNeighbors.some((node) => node.id === memoryNodeId("skill", "workspace-steward"))).toBe(true);
    expect(sessionNeighbors.filter((node) => node.kind === "message")).toHaveLength(2);

    const engineerEdges = first.getIncidentEdges(memoryNodeId("profile", "engineer"));
    expect(engineerEdges.filter((edge) => edge.kind === "uses-skill")).toHaveLength(1);
    expect(first.stats.maxDegree).toBeGreaterThan(0);
  });

  it("auto-links unambiguous file, profile, and skill mentions without guessing ambiguous basenames", () => {
    const graph = deriveMemoryRelationshipGraph({
      profiles: [{ id: "reviewer", name: "Security Reviewer" }],
      skills: [{ id: "workspace-steward", name: "Workspace Steward" }],
      workspaceFiles: [
        { path: "docs/README.md" },
        { path: "apps/README.md" },
        { path: "docs/guide.md" },
      ],
      sessions: [{
        id: "session",
        messages: [{
          id: "message",
          role: "user",
          content: "Ask Security Reviewer and Workspace Steward about README.md and docs/guide.md.",
        }],
      }],
    });
    const message = graph.nodes.find((node) => node.kind === "message")!;
    const referencedFiles = graph.getNeighbors(message.id, ["references-file"]);

    expect(referencedFiles.map((node) => node.label)).toEqual(["docs/guide.md"]);
    expect(graph.getNeighbors(message.id, ["mentions-profile"]).map((node) => node.key)).toEqual(["reviewer"]);
    expect(graph.getNeighbors(message.id, ["mentions-skill"]).map((node) => node.key)).toEqual(["workspace-steward"]);
  });

  it("keeps the newest messages and reports every active bound", () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      id: `message-${index}`,
      role: "user" as const,
      content: `message ${index} contains enough text to exceed the scan budget`,
    }));
    const graph = deriveMemoryRelationshipGraph({
      workspaceFiles: [
        { path: "a.md", content: "a".repeat(30) },
        { path: "b.md" },
        { path: "c.md" },
      ],
      sessions: [{ id: "session", messages }],
    }, {
      maxMessagesPerSession: 2,
      maxFiles: 1,
      maxEdges: 1,
      maxTextScanChars: 10,
    });

    const messageLabels = graph.nodes.filter((node) => node.kind === "message").map((node) => node.label);
    expect(messageLabels).toEqual(expect.arrayContaining([expect.stringContaining("message 3"), expect.stringContaining("message 4")]));
    expect(messageLabels.some((label) => label.includes("message 0"))).toBe(false);
    expect(graph.stats.truncated.messages).toBe(3);
    expect(graph.stats.truncated.files).toBe(2);
    expect(graph.stats.truncated.edges).toBeGreaterThan(0);
    expect(graph.stats.truncated.unscannedCharacters).toBeGreaterThan(0);
    expect(graph.stats.edgeCount).toBe(1);
  });

  it("extracts bounded word and phrase nodes with counted, source-backed relationships", () => {
    const graph = deriveMemoryRelationshipGraph({
      workspaceFiles: [{ path: "memory.md", content: "memory graph private workspace" }],
      sessions: [{
        id: "session",
        messages: [{ id: "message", role: "user", content: "Memory graph reveals memory relationships." }],
      }],
    }, {
      maxTerms: 20,
      maxTermsPerDocument: 8,
      maxCooccurrencePairsPerDocument: 100,
      maxTermEdges: 1_000,
    });
    const memory = graph.getNode(memoryNodeId("term", "token:memory"))!;
    const graphTerm = graph.getNode(memoryNodeId("term", "token:graph"))!;

    expect(memory.metadata).toMatchObject({
      term: "memory",
      termType: "token",
      occurrences: 3,
      documentCount: 2,
      lineage: "normalized-extractive",
    });
    expect(graph.nodes.some((node) => node.kind === "term" && node.label === "and")).toBe(false);
    const mentions = graph.getIncidentEdges(memory.id).filter((edge) => edge.kind === "mentions");
    expect(mentions.map((edge) => edge.metadata.occurrenceCount).sort()).toEqual([1, 2]);
    const cooccurs = graph.edges.find((edge) =>
      edge.kind === "co-occurs"
      && new Set([edge.source, edge.target]).has(memory.id)
      && new Set([edge.source, edge.target]).has(graphTerm.id),
    );
    expect(cooccurs).toMatchObject({ directed: false, metadata: { documentCount: 2, occurrenceCount: 2 } });
  });

  it("enforces per-source and global term materialization limits", () => {
    const graph = deriveMemoryRelationshipGraph({
      workspaceFiles: [{ path: "later.md", content: "lambda mu nu xi omicron" }],
      sessions: [{
        id: "session",
        messages: [{ id: "message", role: "user", content: "alpha beta gamma delta epsilon zeta eta theta iota kappa" }],
      }],
    }, {
      maxTermDocuments: 1,
      maxTermsPerDocument: 10,
      maxTermCandidates: 5,
      maxTerms: 3,
      maxTermEdges: 2,
      maxCooccurrencePairsPerDocument: 1,
    });

    expect(graph.stats.nodeKinds.term).toBe(3);
    expect(graph.stats.edgeKinds.mentions + graph.stats.edgeKinds["co-occurs"]).toBe(2);
    expect(graph.stats.truncated.termDocuments).toBeGreaterThan(0);
    expect(graph.stats.truncated.termCandidates).toBeGreaterThan(0);
    expect(graph.stats.truncated.terms).toBeGreaterThan(0);
    expect(graph.stats.truncated.termEdges).toBeGreaterThan(0);
  });

  it("provides ranked search and bounded relationship selections", () => {
    const graph = deriveMemoryRelationshipGraph(relationshipFixture, { autoLinkText: false });
    const results = graph.search("security reviewer", { kinds: ["profile"] });

    expect(results[0]?.node.id).toBe(memoryNodeId("profile", "reviewer"));
    expect(graph.search("guide", { kinds: ["workspace-file"] }).every((hit) => hit.node.kind === "workspace-file")).toBe(true);
    expect(graph.search("!!!")).toEqual([]);

    const sessionId = memoryNodeId("session", "session-a");
    const containsOnly = graph.select(sessionId, { depth: 1, edgeKinds: ["contains"] });
    expect(containsOnly.nodes.filter((node) => node.kind === "message")).toHaveLength(2);
    expect(containsOnly.nodes.some((node) => node.kind === "profile")).toBe(false);

    const bounded = graph.select(sessionId, { depth: 2, maxNodes: 2 });
    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(graph.select("missing").nodes).toEqual([]);
  });

  it("rejects duplicate identities and unsafe bounds", () => {
    expect(() => deriveMemoryRelationshipGraph({ profiles: [
      { id: "duplicate", name: "One" },
      { id: "duplicate", name: "Two" },
    ] })).toThrow(/Duplicate profile id/u);
    expect(() => deriveMemoryRelationshipGraph({}, { maxNodes: 0 })).toThrow(/maxNodes/u);
  });
});
