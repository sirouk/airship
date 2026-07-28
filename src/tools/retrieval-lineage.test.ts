import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import {
  canonicalContextLineage,
  canonicalContextSelection,
  sealContextSelection,
} from "../core/context-selection";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { FederatedTurnContextProvider } from "../retrieval/federated-turn-context";
import { MemoryWorkspace } from "../workspace/memory";
import { registerContextTools } from "./context-tools";
import { registerFederatedMemoryTool } from "./federated-memory";
import { registerMemoryTools, MEMORY_PATH } from "./memory-tools";
import { allowAllForTests, ToolRegistry } from "./registry";

describe("agent-facing retrieval lineage", () => {
  it("reports the generation, extractor, chunker and embedding posture behind search_context hits", async () => {
    const fixture = await harness();
    const result = await fixture.run("search_context", { query: "brass turbine governor", limit: 4 });
    const payload = JSON.parse(result.content) as Record<string, never>;
    const lineage = canonicalContextLineage(payload.lineage);
    expect(lineage).toBeDefined();
    expect(lineage!.retriever).toBe("airship-workspace-tool-search-v1");
    const generation = lineage!.generations[0]!;
    expect(generation.corpus).toBe("workspace");
    expect(generation.embedding).toMatchObject({ posture: "deterministic-bootstrap" });
    expect(generation.extractor).toBeTruthy();
    expect(generation.chunker).toContain("max=");
    expect(generation.persistence).toBe("memory-only");
    // Every hit points at the generation that produced it.
    for (const hit of payload.hits as unknown as { lineageRef: string }[]) {
      expect(hit.lineageRef).toBe(generation.id);
    }
    expect(result.metadata).toMatchObject({ embeddingPosture: "deterministic-bootstrap" });

    // The digest is labeled a payload digest because the payload is above the
    // canonical hit limit and is not byte-accounted; sealing it would be false.
    expect(payload.payloadDigest).toMatch(/^sha256:/u);
    expect(payload).not.toHaveProperty("selectionDigest");
    expect(canonicalContextSelection(payload)).toBeUndefined();
  });

  it("attaches the memory.json generation to the search_memory profile lane", async () => {
    const fixture = await harness();
    const result = await fixture.run("search_memory", { query: "pressure limit", limitPerGroup: 4 });
    const parsed = JSON.parse(result.content) as { groups: { lineage?: unknown; hits: unknown[] }[] };
    const profileGroup = parsed.groups[1]!;
    expect(profileGroup.hits.length).toBeGreaterThan(0);
    const lineage = canonicalContextLineage(profileGroup.lineage);
    expect(lineage).toBeDefined();
    expect(lineage!.retriever).toBe("airship-profile-memory-tool-v1");
    expect(lineage!.generations[0]).toMatchObject({
      corpus: "profile-memory",
      extractor: "airship-explicit-memory-v2",
      chunker: "record-boundary-v1",
      persistence: "memory-only",
    });
    expect(lineage!.generations[0]!.sourceDigest).toBe(await sha256(fixture.memoryDocument));
    expect(canonicalContextLineage(parsed.groups[2]!.lineage)?.retriever).toBe("airship-workspace-tool-search-v1");
  });

  it("refuses a turn selection that claims an agent-invoked tool retriever", async () => {
    const fixture = await harness();
    const selection = await fixture.provider.selectForTurn("brass turbine governor", {
      sessionId: fixture.sessionId, maxHits: 4, maxBytes: 4_096,
    });
    expect(selection.lineage!.retriever).toBe("airship-federated-turn-context-v1");
    expect(canonicalContextSelection(selection)).toBeDefined();

    const { selectionDigest, ...rest } = selection;
    void selectionDigest;
    const relabelled = await sealContextSelection({
      ...rest,
      lineage: { ...selection.lineage!, retriever: "airship-workspace-tool-search-v1" },
    });
    // The tool retriever ids are valid lineage on a tool payload and never on a
    // turn selection. The union documented that in a comment; only the validator
    // can make it true, since a relabelled selection reseals perfectly.
    expect(canonicalContextLineage(relabelled.lineage)).toBeDefined();
    expect(canonicalContextSelection(relabelled)).toBeUndefined();
  });

  it("returns per-record content digests and the memory source digest from recall_memory", async () => {
    const fixture = await harness();
    const result = await fixture.run("recall_memory", { query: "pressure" });
    const records = JSON.parse(result.content) as { content: string; contentDigest: string }[];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.contentDigest).toBe(await sha256(record.content));
    }
    expect(result.metadata).toMatchObject({
      ranking: "bounded-bm25-recent-v1",
      sourceDigest: await sha256(fixture.memoryDocument),
    });
  });
});

async function harness() {
  const workspace = new MemoryWorkspace();
  await workspace.write("docs/turbine.md", "The brass turbine uses a pressure governor in the browser workspace.");
  const journal = new EventJournal(new MemoryJournalBackend());
  const digest = await sha256("engineer-profile");
  const manifest = await createSessionManifest({
    systemPrompt: "Retrieve carefully.", providerId: "test", model: "test", tools: [],
    workspaceId: "memory://retrieval-lineage",
    profile: {
      version: 2, profileId: "engineer", profileRevision: digest, themeId: "plain", themeDigest: digest,
      resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
      workspaceBinding: { kind: "active-workspace" }, memoryScope: "profile",
      approvalMode: "ask-first", minimumPosture: "local",
    },
  });
  const session = await journal.createSession("Engineer", manifest);
  const memoryDocument = `${JSON.stringify({
    version: 2,
    records: [{
      id: "memory-pressure-policy",
      content: "The turbine pressure limit is 42 bar.",
      source: "turn:pressure-review",
      createdAt: "2026-07-22T00:00:00.000Z",
      scope: {
        kind: "profile", profileId: "engineer", profileRevision: digest, createdInSessionId: session.id,
      },
    }],
  })}\n`;
  await workspace.write(MEMORY_PATH, memoryDocument);

  const runtime = new ClientContextRuntime(workspace, { dimensions: 64 });
  const registry = new ToolRegistry();
  registerContextTools(registry, runtime);
  registerMemoryTools(registry, workspace, journal);
  registerFederatedMemoryTool(registry, workspace, journal, runtime);
  return {
    memoryDocument,
    sessionId: session.id,
    provider: new FederatedTurnContextProvider(runtime, workspace, journal),
    run: async (name: string, args: Record<string, unknown>) => {
      const context = {
        sessionId: session.id,
        turnId: "turn",
        operationId: `operation-${name}`,
        signal: new AbortController().signal,
      };
      expect(await registry.review(name, args as never, context, allowAllForTests)).toBe("allow");
      return registry.executeApproved(name, args as never, context);
    },
  };
}
