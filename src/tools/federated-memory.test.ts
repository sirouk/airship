import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { MemoryWorkspace } from "../workspace/memory";
import { MEMORY_PATH } from "./memory-tools";
import { searchFederatedMemory } from "./federated-memory";

describe("federated memory lanes", () => {
  it("keeps current thread, active-profile memory, and shared workspace results grouped", async () => {
    const fixture = await setup();
    const result = await searchFederatedMemory({
      query: "turbine",
      limit: 6,
      context: context(fixture.engineer),
      workspace: fixture.workspace,
      journal: fixture.journal,
      runtime: fakeRuntime([
        workspaceHit("/workspace/docs/turbine.md", "chunk-1", 0.9),
        workspaceHit("/workspace/docs/turbine.md", "chunk-1", 0.4),
      ]),
    });

    expect(result.authority).toMatchObject({ sessionId: fixture.engineer, profileId: "engineer" });
    expect(result.groups.map((group) => [group.corpus, group.priority])).toEqual([
      ["current-thread", 1],
      ["active-profile-memory", 2],
      ["shared-workspace-index", 3],
    ]);
    expect(JSON.stringify(result.groups[0])).toContain("thread turbine");
    expect(JSON.stringify(result.groups[0])).not.toContain("other-profile transcript turbine");
    expect(JSON.stringify(result.groups[1])).toContain("engineer memory turbine");
    expect(JSON.stringify(result.groups[1])).not.toContain("researcher memory turbine");
    expect(result.groups[2].hits).toHaveLength(1);
    expect(result.groups[2].duplicatesSuppressed).toBe(1);
    expect(result.groups[2].ranking).toContain("never comparable across groups");
    expect(result.groups[2].hits[0]).toMatchObject({ score: 0.9, scoreScope: "shared-workspace-index-only" });
  });

  it("narrows the profile lane to the pinned session when the silo is session-scoped", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const current = await createProfileSession(journal, "research", "session");
    const sibling = await createProfileSession(journal, "research", "session");
    await workspace.write(MEMORY_PATH, `${JSON.stringify({
      version: 2,
      records: [
        memory("memory-current", "current session turbine", "research", current),
        memory("memory-sibling", "sibling session turbine", "research", sibling),
      ],
    })}\n`);

    const result = await searchFederatedMemory({
      query: "turbine",
      limit: 6,
      context: context(current),
      workspace,
      journal,
      runtime: fakeRuntime([]),
    });

    expect(result.groups[1].hits.map((hit) => hit.id)).toEqual(["memory-current"]);
    expect(JSON.stringify(result)).not.toContain("sibling session turbine");
  });

  it("fails the federated request instead of returning stale workspace hits", async () => {
    const fixture = await setup();
    const runtime = { search: async () => { throw new Error("workspace snapshot changed during search"); } } as unknown as ClientContextRuntime;
    await expect(searchFederatedMemory({
      query: "turbine",
      limit: 6,
      context: context(fixture.engineer),
      workspace: fixture.workspace,
      journal: fixture.journal,
      runtime,
    })).rejects.toThrow("snapshot changed");
  });
});

async function setup() {
  const workspace = new MemoryWorkspace();
  const journal = new EventJournal(new MemoryJournalBackend());
  const engineer = await createProfileSession(journal, "engineer");
  const researcher = await createProfileSession(journal, "researcher");
  await journal.append(engineer, [{
    type: "turn.requested",
    turnId: "turn-engineer",
    payload: { content: "current thread turbine" },
  }]);
  await journal.append(researcher, [{
    type: "turn.requested",
    turnId: "turn-researcher",
    payload: { content: "other-profile transcript turbine" },
  }]);
  await workspace.write(MEMORY_PATH, `${JSON.stringify({
    version: 2,
    records: [
      memory("memory-engineer", "engineer memory turbine", "engineer", engineer),
      memory("memory-researcher", "researcher memory turbine", "researcher", researcher),
    ],
  })}\n`);
  return { workspace, journal, engineer };
}

async function createProfileSession(
  journal: EventJournal,
  profileId: string,
  memoryScope?: "session" | "profile" | "workspace",
): Promise<string> {
  const digest = await sha256(profileId);
  const base = {
    profileId, profileRevision: digest, themeId: "test", themeDigest: digest,
    resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
  };
  const manifest = await createSessionManifest({
    systemPrompt: profileId,
    providerId: "test",
    model: "test",
    tools: [],
    workspaceId: "memory://test",
    profile: memoryScope
      ? {
        ...base, version: 2, workspaceBinding: { kind: "active-workspace" },
        memoryScope, approvalMode: "ask-first",
      }
      : { ...base, version: 1 },
  });
  return (await journal.createSession(profileId, manifest)).id;
}

function memory(id: string, content: string, profileId: string, sessionId: string) {
  return {
    id, content, source: "test", createdAt: "2026-07-18T00:00:00.000Z",
    scope: { kind: "profile", profileId, profileRevision: `revision-${profileId}`, createdInSessionId: sessionId },
  };
}

function workspaceHit(path: string, chunkId: string, score: number) {
  return {
    path, chunkId, score, text: "workspace turbine", revision: "r1",
    contentDigest: "sha256:workspace", denseScore: score, lexicalScore: score, chunkIndex: 0,
  };
}

function fakeRuntime(hits: ReturnType<typeof workspaceHit>[]): ClientContextRuntime {
  return {
    // No materialized generation: the workspace lane then reports no lineage
    // rather than inventing one.
    getState: () => ({ generation: undefined }),
    search: async () => ({
      query: "turbine",
      queryDigest: "sha256:query",
      generationDigest: "sha256:generation",
      workspaceSnapshotDigest: "sha256:snapshot",
      durationMs: 1,
      completedAt: "2026-07-18T00:00:00.000Z",
      hits,
    }),
  } as unknown as ClientContextRuntime;
}

function context(sessionId: string) {
  return { sessionId, turnId: "turn", operationId: "operation", signal: new AbortController().signal };
}
