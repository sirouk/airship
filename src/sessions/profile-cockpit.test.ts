import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/session-manifest";
import type { SessionManifest } from "../core/contracts";
import { EventJournal } from "../core/journal";
import { sha256 } from "../core/hash";
import { MemoryJournalBackend } from "../core/memory-journal";
import { auditSessionHistory } from "../core/session-audit";
import {
  PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
  ProfileActiveConversationConflictError,
  profileOwnedSessions,
  requireProfileOwnedSession,
  resolveProfileActiveConversation,
  resolveResumableProfileConversation,
  resumableProfileManifestMatches,
  selectProfileActiveConversation,
} from "./profile-cockpit";

async function manifest(systemPrompt: string, overrides: Partial<SessionManifest> = {}): Promise<SessionManifest> {
  const digest = `sha256:${"A".repeat(43)}`;
  const base = await createSessionManifest({
    systemPrompt,
    providerId: "airship-demo",
    model: "airship/demo-v1",
    tools: [{ name: "read_file", description: "Read", inputSchema: {}, effect: "read" }],
    workspaceId: "workspace-1",
    securityPosture: "local",
    capabilityTier: "web-baseline",
    turnContext: "required",
    profile: {
      version: 2,
      profileId: "research",
      profileRevision: digest,
      themeId: "verdigris",
      themeDigest: digest,
      resolvedSkills: [],
      skillSetDigest: await sha256("[]"),
      resolutionDigest: await sha256(systemPrompt),
      workspaceBinding: { kind: "active-workspace" },
      memoryScope: "profile",
      approvalMode: "ask-first",
      minimumPosture: "local",
    },
  });
  return { ...base, ...overrides } as SessionManifest;
}

describe("profile cockpit resume matching", () => {
  it("keeps an immutable conversation resumable when only live prompt observations changed", async () => {
    const actual = await manifest("WebGPU was unavailable when this conversation began.");
    const expected = await manifest("WebGPU is available in the live environment now.", { capabilityTier: "web-enhanced" });
    expect(actual.systemPromptDigest).not.toBe(expected.systemPromptDigest);
    expect(actual.profile?.resolutionDigest).not.toBe(expected.profile?.resolutionDigest);
    expect(resumableProfileManifestMatches(actual, expected)).toBe(true);
  });

  it("rejects changes to stable profile, tool, and runtime pins", async () => {
    const actual = await manifest("Pinned prompt");
    expect(resumableProfileManifestMatches(actual, await manifest("Pinned prompt", { model: "other/model" }))).toBe(false);
    expect(resumableProfileManifestMatches(actual, {
      ...actual,
      toolManifestDigest: "sha256:other-tools",
    })).toBe(false);
    expect(resumableProfileManifestMatches(actual, {
      ...actual,
      profile: { ...actual.profile!, profileRevision: "sha256:new-profile" },
    })).toBe(false);
  });
});

describe("profile-owned session command authority", () => {
  it("filters command listings and rejects an exact cross-profile source ID", async () => {
    const research = await manifest("Research session");
    const general = await manifest("General session", {
      profile: { ...research.profile!, profileId: "general" },
    });
    const journal = new EventJournal(new MemoryJournalBackend());
    const researchSession = await journal.createSession("Research", research);
    const generalSession = await journal.createSession("General secret", general);

    expect(profileOwnedSessions(await journal.listSessions(), "research").map((session) => session.id))
      .toEqual([researchSession.id]);
    expect(() => requireProfileOwnedSession(generalSession, "research", "fork"))
      .toThrow(/another Profile.*fork/u);
    expect(requireProfileOwnedSession(researchSession, "research", "open")).toBe(researchSession);
  });
});

describe("durable profile active-conversation pointer", () => {
  it("records A → B → A as an exact profile-local append-only selection", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const pinned = await manifest("Pinned profile cockpit");
    const first = await journal.createSession("A", pinned);
    const second = await journal.createSession("B", pinned);

    const selectedA = await selectProfileActiveConversation(journal, "research", first.id);
    const selectedB = await selectProfileActiveConversation(journal, "research", second.id);
    const selectedAAgain = await selectProfileActiveConversation(journal, "research", first.id);
    expect([selectedA.pointer.generation, selectedB.pointer.generation, selectedAAgain.pointer.generation]).toEqual([1, 2, 3]);

    const restored = await resolveProfileActiveConversation(journal, "research");
    expect(restored).toMatchObject({ state: "selected", session: { id: first.id }, pointer: { sessionId: first.id } });
    expect((await journal.listSessions()).map((session) => session.id)).toHaveLength(2);

    const current = (await journal.getSession(first.id))!;
    const report = await auditSessionHistory({ session: current, events: await journal.readEvents(first.id) });
    expect(report.status, JSON.stringify(report.findings)).toBe("verified");
    expect(report.findings.map((finding) => finding.code)).not.toContain("EVENT_TYPE_UNKNOWN");
    expect(report.findings.map((finding) => finding.code)).not.toContain("PROFILE_ACTIVE_CONVERSATION_MALFORMED");
  });

  it("keeps page-memory authorities isolated and never manufactures a session while resolving", async () => {
    const firstAuthority = new EventJournal(new MemoryJournalBackend());
    const secondAuthority = new EventJournal(new MemoryJournalBackend());
    const pinned = await manifest("Authority scoped pointer");
    const selected = await firstAuthority.createSession("Selected", pinned);
    await secondAuthority.createSession("Other authority", pinned);
    await selectProfileActiveConversation(firstAuthority, "research", selected.id);

    expect((await resolveProfileActiveConversation(firstAuthority, "research")).session?.id).toBe(selected.id);
    expect(await resolveProfileActiveConversation(secondAuthority, "research")).toEqual({
      profileId: "research",
      state: "no-selection",
    });
    const before = (await secondAuthority.listSessions()).length;
    expect(await resolveResumableProfileConversation(secondAuthority, "research", pinned)).toBeDefined();
    expect((await secondAuthority.listSessions()).length).toBe(before);
  });

  it("prefers the explicit selection over a more recently edited compatible conversation", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const pinned = await manifest("Pointer beats incidental recency");
    const selected = await journal.createSession("Selected", pinned);
    const newerEdit = await journal.createSession("Incidental", pinned);
    await selectProfileActiveConversation(journal, "research", selected.id);
    await journal.renameSession(newerEdit.id, "Incidental newest edit");

    expect((await resolveResumableProfileConversation(journal, "research", pinned))?.id).toBe(selected.id);
  });

  it("resolves equal-generation concurrent selections deterministically", async () => {
    const journal = new EventJournal(
      new MemoryJournalBackend(),
      () => "2026-07-28T12:00:00.000Z",
    );
    const pinned = await manifest("Concurrent pointer convergence");
    const first = await journal.createSession("First writer", pinned);
    const second = await journal.createSession("Second writer", pinned);
    const [firstEvent] = await journal.append(first.id, [{
      type: PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
      payload: { version: 1, profileId: "research", sessionId: first.id, generation: 1 },
    }]);
    const [secondEvent] = await journal.append(second.id, [{
      type: PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
      payload: { version: 1, profileId: "research", sessionId: second.id, generation: 1 },
    }]);
    const expected = [firstEvent, secondEvent]
      .sort((left, right) => right.eventId.localeCompare(left.eventId) || right.sessionId.localeCompare(left.sessionId))[0]!;

    const firstResolution = await resolveProfileActiveConversation(journal, "research");
    const secondResolution = await resolveProfileActiveConversation(journal, "research");
    expect(firstResolution.pointer?.eventId).toBe(expected.eventId);
    expect(firstResolution.session?.id).toBe(expected.sessionId);
    expect(secondResolution).toEqual(firstResolution);
  });

  it("reports a missing target and falls back to an existing compatible record without creating one", async () => {
    let tick = 0;
    const journal = new EventJournal(
      new MemoryJournalBackend(),
      () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)).toISOString(),
    );
    const pinned = await manifest("Missing target fallback");
    const first = await journal.createSession("First", pinned);
    const fallback = await journal.createSession("Fallback", pinned);
    const initial = await selectProfileActiveConversation(journal, "research", first.id);
    await journal.append(fallback.id, [{
      type: PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
      payload: {
        version: 1,
        profileId: "research",
        sessionId: "deleted-session",
        generation: initial.pointer.generation + 1,
        previousEventId: initial.pointer.eventId,
      },
    }]);

    expect(await resolveProfileActiveConversation(journal, "research")).toMatchObject({
      state: "missing-target",
      pointer: { sessionId: "deleted-session" },
    });
    const before = (await journal.listSessions()).length;
    expect((await resolveResumableProfileConversation(journal, "research", pinned))?.id).toBe(fallback.id);
    expect((await journal.listSessions()).length).toBe(before);
  });

  it("fences an audited target head and rejects cross-profile selection", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const pinned = await manifest("Head fence");
    const session = await journal.createSession("Fenced", pinned);
    await journal.renameSession(session.id, "Changed concurrently");
    await expect(selectProfileActiveConversation(journal, "research", session.id, {
      expectedTargetHead: { sequence: session.headSequence, digest: session.headDigest },
    })).rejects.toBeInstanceOf(ProfileActiveConversationConflictError);
    await expect(selectProfileActiveConversation(journal, "general", session.id)).rejects.toThrow(/owning profile/u);
  });
});
