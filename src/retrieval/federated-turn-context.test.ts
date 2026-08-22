import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { verifyContextSelection } from "../core/context-selection";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MEMORY_PATH } from "../tools/memory-tools";
import { MemoryWorkspace } from "../workspace/memory";
import { ClientContextRuntime } from "./client-context-runtime";
import { FederatedTurnContextProvider } from "./federated-turn-context";

describe("FederatedTurnContextProvider", () => {
  it("injects profile memory and workspace retrieval with one referenced lineage graph", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("docs/turbine.md", "The brass turbine uses a pressure governor in the browser workspace.");
    const journal = new EventJournal(new MemoryJournalBackend());
    const digest = await sha256("builder-profile");
    const manifest = await createSessionManifest({
      systemPrompt: "Build carefully.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://federated-context",
      profile: {
        version: 2,
        profileId: "builder",
        profileRevision: digest,
        themeId: "plain",
        themeDigest: digest,
        resolvedSkills: [],
        skillSetDigest: digest,
        resolutionDigest: digest,
        workspaceBinding: { kind: "active-workspace" },
        memoryScope: "profile",
        approvalMode: "ask-first",
      },
    });
    const session = await journal.createSession("Builder", manifest);
    await workspace.write(MEMORY_PATH, `${JSON.stringify({
      version: 2,
      records: [{
        id: "memory-pressure-policy",
        content: "The turbine pressure limit is 42 bar.",
        source: "turn:pressure-review",
        createdAt: "2026-07-22T00:00:00.000Z",
        scope: {
          kind: "profile",
          profileId: "builder",
          profileRevision: digest,
          createdInSessionId: session.id,
        },
      }],
    })}\n`);

    const runtime = new ClientContextRuntime(workspace, { dimensions: 64 });
    const provider = new FederatedTurnContextProvider(runtime, workspace, journal);
    const selection = await provider.selectForTurn("turbine pressure", {
      sessionId: session.id,
      maxHits: 4,
      maxBytes: 4_096,
    });

    expect(selection.version).toBe(2);
    expect(await verifyContextSelection(selection)).toBe(true);
    expect(selection.lineage?.scope).toMatchObject({
      sessionId: session.id,
      profileId: "builder",
      memoryScope: "profile",
      workspaceId: "memory://federated-context",
    });
    expect(selection.lineage?.generations.map((generation) => generation.corpus)).toEqual([
      "profile-memory",
      "workspace",
    ]);
    expect(selection.hits.map((hit) => hit.corpus)).toContain("profile-memory");
    expect(selection.hits.map((hit) => hit.corpus)).toContain("workspace");
    for (const hit of selection.hits) {
      expect(selection.lineage?.generations.some((generation) => generation.id === hit.lineageRef)).toBe(true);
      expect(hit.contentDigest).toMatch(/^sha256:/u);
      expect(hit.revision).toBeTruthy();
    }
  });

  it("honors a session-scoped profile without leaking sibling-session memories", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("notes/empty.md", "unrelated workspace material");
    const journal = new EventJournal(new MemoryJournalBackend());
    const digest = await sha256("session-profile");
    const profile = {
      version: 2 as const,
      profileId: "research",
      profileRevision: digest,
      themeId: "plain",
      themeDigest: digest,
      resolvedSkills: [],
      skillSetDigest: digest,
      resolutionDigest: digest,
      workspaceBinding: { kind: "active-workspace" as const },
      memoryScope: "session" as const,
      approvalMode: "ask-first" as const,
    };
    const manifest = await createSessionManifest({
      systemPrompt: "Research.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://session-context", profile,
    });
    const current = await journal.createSession("Current", manifest);
    const sibling = await journal.createSession("Sibling", manifest);
    await workspace.write(MEMORY_PATH, `${JSON.stringify({ version: 2, records: [
      memory("owned", "session quartz owned", current.id, digest),
      memory("sibling", "session quartz sibling", sibling.id, digest),
    ] })}\n`);
    const provider = new FederatedTurnContextProvider(
      new ClientContextRuntime(workspace, { dimensions: 64 }), workspace, journal,
    );

    const selection = await provider.selectForTurn("quartz", { sessionId: current.id });
    const memoryHits = selection.hits.filter((hit) => hit.corpus === "profile-memory");
    expect(memoryHits).toHaveLength(1);
    expect(memoryHits[0]?.sourceId).toBe("owned");
    expect(JSON.stringify(selection)).not.toContain("session quartz sibling");
  });

  it("recalls another conversation in this profile, and only inside the turn's own budget", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const digest = await sha256("ambient-profile");
    const profile = {
      version: 2 as const, profileId: "ambient", profileRevision: digest, themeId: "plain",
      themeDigest: digest, resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
      workspaceBinding: { kind: "active-workspace" as const }, memoryScope: "profile" as const,
      approvalMode: "ask-first" as const,
    };
    const manifest = await createSessionManifest({
      systemPrompt: "Be useful.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://ambient-recall", profile,
    });
    const earlier = await journal.createSession("Drinks", manifest);
    await journal.append(earlier.id, [{
      type: "turn.requested", turnId: "t1",
      payload: { content: "I like unicorn milk and I want it to be blue" },
    }]);
    const current = await journal.createSession("Later", manifest);
    const provider = new FederatedTurnContextProvider(
      new ClientContextRuntime(workspace, { dimensions: 64 }), workspace, journal,
    );

    const selection = await provider.selectForTurn("what kind of milk do I like most?", {
      sessionId: current.id, maxHits: 4, maxBytes: 4_096,
    });

    expect(await verifyContextSelection(selection)).toBe(true);
    const recalled = selection.hits.filter((hit) => hit.corpus === "conversation");
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.text).toContain('You said, in "Drinks" (turn 2');
    expect(recalled[0]?.text).toContain("I like unicorn milk and I want it to be blue");
    expect(recalled[0]?.sourceId).toBe(earlier.id);
    expect(selection.lineage?.generations.map((generation) => generation.corpus)).toContain("conversation");
    for (const hit of recalled) {
      expect(selection.lineage?.generations.some((generation) => generation.id === hit.lineageRef)).toBe(true);
    }
    expect(selection.selectedBytes).toBeLessThanOrEqual(4_096);
  });

  it("adds no hit and no generation when nothing said before is relevant", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const digest = await sha256("ambient-profile");
    const manifest = await createSessionManifest({
      systemPrompt: "Be useful.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://ambient-quiet",
      profile: {
        version: 2, profileId: "ambient", profileRevision: digest, themeId: "plain",
        themeDigest: digest, resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
        workspaceBinding: { kind: "active-workspace" }, memoryScope: "profile", approvalMode: "ask-first",
      },
    });
    const earlier = await journal.createSession("Drinks", manifest);
    await journal.append(earlier.id, [{
      type: "turn.requested", turnId: "t1",
      payload: { content: "I like unicorn milk and I want it to be blue" },
    }]);
    const current = await journal.createSession("Keys", manifest);
    const provider = new FederatedTurnContextProvider(
      new ClientContextRuntime(workspace, { dimensions: 64 }), workspace, journal,
    );

    const selection = await provider.selectForTurn("how do I rotate a private key?", {
      sessionId: current.id, maxHits: 4, maxBytes: 4_096,
    });

    expect(selection.hits).toEqual([]);
    expect(selection.selectedBytes).toBe(0);
    expect(selection.lineage?.generations.map((generation) => generation.corpus)).not.toContain("conversation");
  });

  it("cannot recall a conversation that belongs to another profile", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const digest = await sha256("two-profiles");
    const binding = (profileId: string) => ({
      version: 2 as const, profileId, profileRevision: digest, themeId: "plain",
      themeDigest: digest, resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
      workspaceBinding: { kind: "active-workspace" as const }, memoryScope: "profile" as const,
      approvalMode: "ask-first" as const,
    });
    const theirs = await journal.createSession("Theirs", await createSessionManifest({
      systemPrompt: "Be useful.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://ambient-other", profile: binding("other"),
    }));
    await journal.append(theirs.id, [{
      type: "turn.requested", turnId: "t1",
      payload: { content: "I like unicorn milk and I want it to be blue" },
    }]);
    const mine = await journal.createSession("Mine", await createSessionManifest({
      systemPrompt: "Be useful.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://ambient-mine", profile: binding("mine"),
    }));
    const provider = new FederatedTurnContextProvider(
      new ClientContextRuntime(workspace, { dimensions: 64 }), workspace, journal,
    );

    const selection = await provider.selectForTurn("what kind of milk do I like most?", {
      sessionId: mine.id, maxHits: 4, maxBytes: 4_096,
    });

    expect(selection.hits).toEqual([]);
    expect(JSON.stringify(selection)).not.toContain("unicorn");
  });
});

function memory(id: string, content: string, sessionId: string, profileRevision: string) {
  return {
    id,
    content,
    source: `turn:${id}`,
    createdAt: "2026-07-22T00:00:00.000Z",
    scope: {
      kind: "profile",
      profileId: "research",
      profileRevision,
      createdInSessionId: sessionId,
    },
  };
}
