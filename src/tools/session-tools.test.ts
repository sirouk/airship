import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { allowAllForTests, ToolRegistry } from "./registry";
import { registerSessionTools } from "./session-tools";

describe("profile-scoped session search", () => {
  it("does not expose another profile's transcript or accept its session ID", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const registry = new ToolRegistry();
    registerSessionTools(registry, journal);
    const engineerA = await session(journal, registry, "engineer", "Engineer A");
    const engineerB = await session(journal, registry, "engineer", "Engineer B");
    const researcher = await session(journal, registry, "researcher", "Researcher");
    await journal.append(engineerB, [{ type: "turn.requested", turnId: "e", payload: { content: "same-profile turbine" } }]);
    await journal.append(researcher, [{ type: "turn.requested", turnId: "r", payload: { content: "cross-profile turbine" } }]);

    const listed = await run(registry, engineerA, {}, "list");
    expect(JSON.parse(listed.content).map((item: { id: string }) => item.id).sort()).toEqual([engineerA, engineerB].sort());
    const searched = await run(registry, engineerA, { query: "turbine" }, "search");
    expect(searched.content).toContain("same-profile turbine");
    expect(searched.content).not.toContain("cross-profile turbine");
    await expect(run(registry, engineerA, { sessionId: researcher }, "cross-target"))
      .rejects.toThrow("outside the caller's pinned profile scope");
  });
});

async function session(journal: EventJournal, registry: ToolRegistry, profileId: string, title: string) {
  const digest = await sha256(profileId);
  const manifest = await createSessionManifest({
    systemPrompt: profileId,
    providerId: "test",
    model: "test",
    tools: registry.definitions(),
    workspaceId: "memory://test",
    profile: {
      version: 1, profileId, profileRevision: digest, themeId: "test", themeDigest: digest,
      resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
    },
  });
  return (await journal.createSession(title, manifest)).id;
}

async function run(registry: ToolRegistry, sessionId: string, args: Record<string, unknown>, operationId: string) {
  const context = { sessionId, turnId: operationId, operationId, signal: new AbortController().signal };
  expect(await registry.review("search_sessions", args as never, context, allowAllForTests)).toBe("allow");
  return registry.executeApproved("search_sessions", args as never, context);
}
