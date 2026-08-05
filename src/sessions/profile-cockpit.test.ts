import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/session-manifest";
import type { SessionManifest } from "../core/contracts";
import { EventJournal, type JournalBackend } from "../core/journal";
import { sha256 } from "../core/hash";
import { MemoryJournalBackend } from "../core/memory-journal";
import { auditSessionHistory } from "../core/session-audit";
import {
  PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
  ProfileActiveConversationConflictError,
  profileManifestResumeMismatches,
  profileOwnedSessions,
  requireProfileOwnedSession,
  resolveProfileActiveConversation,
  resolveResumableProfileConversation,
  resumableProfileConversationCandidates,
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

function wrapMemoryBackend(
  inner: MemoryJournalBackend,
  overrides: Partial<JournalBackend>,
): JournalBackend {
  return {
    createSession: (session) => inner.createSession(session),
    getSession: (sessionId) => inner.getSession(sessionId),
    listSessions: () => inner.listSessions(),
    readEvents: (sessionId, afterSequence) => inner.readEvents(sessionId, afterSequence),
    append: (sessionId, expectedHead, events) => inner.append(sessionId, expectedHead, events),
    deleteSession: (sessionId, expectedHead) => inner.deleteSession(sessionId, expectedHead),
    ...overrides,
  };
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
      profile: { ...actual.profile!, skillSetDigest: "sha256:other-skills" },
    })).toBe(false);
    expect(resumableProfileManifestMatches(actual, {
      ...actual,
      profile: { ...actual.profile!, approvalMode: "full-access" },
    } as SessionManifest)).toBe(false);
    expect(resumableProfileManifestMatches(actual, {
      ...actual,
      profile: { ...actual.profile!, profileId: "general" },
    })).toBe(false);
  });

  /*
   * A profile edit that changes nothing a turn is run by must not cost the
   * person their conversations.
   *
   * The catalog holds one revision per profile, so the revision a conversation
   * pinned stops existing the moment the profile is saved again — and the
   * revision digest moves for the interface theme, the profile's name and its
   * description, none of which reach a turn. Comparing it made a theme swap
   * equivalent to a changed pin: the profile reported it "had no compatible
   * conversation" and opened an empty one, and the finished conversation beside
   * it offered "Fork to continue" as its only forward action.
   */
  it("keeps a conversation resumable when a saved profile revision changed only its presentation", async () => {
    const pinned = await manifest("Pinned prompt");
    const afterThemeChange = {
      ...pinned,
      profile: {
        ...pinned.profile!,
        profileRevision: `sha256:${"B".repeat(43)}`,
        themeId: "blue-ledger",
        themeDigest: `sha256:${"C".repeat(43)}`,
        resolutionDigest: `sha256:${"D".repeat(43)}`,
      },
    } as SessionManifest;
    expect(profileManifestResumeMismatches(pinned, afterThemeChange)).toEqual([]);
    expect(resumableProfileManifestMatches(pinned, afterThemeChange)).toBe(true);
  });

  it("resumes a conversation pinned under the withdrawn workspace memory scope", async () => {
    const expected = await manifest("Pinned prompt");
    /*
     * What every conversation of a `workspace`-scoped profile holds — the shipped
     * Research profile was seeded that way — since the scope was withdrawn: the
     * same revision, the same digests, and the word the pin was written with.
     * `workspace` was withdrawn because no reader ever widened anything for it
     * (every memory read narrows on the pinned profile ID), so new pins resolve
     * it to `profile`. Comparing the raw field made the two pins disagree about a
     * boundary that is identical, and the profile then found no resumable
     * conversation at all: its durable pointer and every candidate were rejected,
     * and selecting it silently started an empty conversation instead.
     */
    const pinnedUnderWorkspaceScope = {
      ...expected,
      profile: { ...expected.profile!, memoryScope: "workspace" },
    } as SessionManifest;
    expect(profileManifestResumeMismatches(pinnedUnderWorkspaceScope, expected)).toEqual([]);
    expect(resumableProfileManifestMatches(pinnedUnderWorkspaceScope, expected)).toBe(true);

    // Not a blanket tolerance for the field: `session` is a boundary the readers
    // really do enforce, so it still refuses.
    const pinnedUnderSessionScope = {
      ...expected,
      profile: { ...expected.profile!, memoryScope: "session" },
    } as SessionManifest;
    expect(profileManifestResumeMismatches(pinnedUnderSessionScope, expected)).toEqual(["profile-binding"]);
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

  /*
   * The shelf, not only its top row.
   *
   * A person who closed the tab on an unanswered approval came back to a
   * brand-new empty conversation while a fully resumable 14-event sibling sat
   * in the same list: adoption asked for exactly one candidate, and when that
   * one refused to replay there was nothing else to try.
   */
  it("offers every resumable conversation in order, pointer first then recency", async () => {
    let tick = 0;
    const journal = new EventJournal(
      new MemoryJournalBackend(),
      () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)).toISOString(),
    );
    const pinned = await manifest("Ordered candidates");
    const oldest = await journal.createSession("Oldest", pinned);
    const middle = await journal.createSession("Middle", pinned);
    const newest = await journal.createSession("Newest", pinned);
    await selectProfileActiveConversation(journal, "research", middle.id);

    const candidates = await resumableProfileConversationCandidates(journal, "research", pinned);
    expect(candidates.map((session) => session.id)).toEqual([middle.id, newest.id, oldest.id]);
    // The single-answer form is this list's head and nothing else, so the two
    // can never disagree about which conversation comes back.
    expect((await resolveResumableProfileConversation(journal, "research", pinned))?.id).toBe(candidates[0]?.id);
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

  it("refuses when the target changes after preflight but before the selection append", async () => {
    const inner = new MemoryJournalBackend();
    const racingWriter = new EventJournal(inner);
    let targetSessionId = "";
    let raceOnList = false;
    const journal = new EventJournal(wrapMemoryBackend(inner, {
      async listSessions() {
        const snapshot = await inner.listSessions();
        if (raceOnList) {
          raceOnList = false;
          await racingWriter.renameSession(targetSessionId, "Changed during selection");
        }
        return snapshot;
      },
    }));
    const pinned = await manifest("Head race");
    const target = await journal.createSession("Audited", pinned);
    targetSessionId = target.id;
    const audited = (await journal.getSession(target.id))!;
    raceOnList = true;

    await expect(selectProfileActiveConversation(journal, "research", target.id, {
      expectedTargetHead: { sequence: audited.headSequence, digest: audited.headDigest },
    })).rejects.toBeInstanceOf(ProfileActiveConversationConflictError);

    expect((await journal.getSession(target.id))?.title).toBe("Changed during selection");
    expect((await journal.readEvents(target.id)).map((event) => event.type))
      .toEqual(["session.created", "session.renamed"]);
  });

  it("rechecks the audited head before returning an already-selected target", async () => {
    const inner = new MemoryJournalBackend();
    const racingWriter = new EventJournal(inner);
    let targetSessionId = "";
    let raceOnList = false;
    const journal = new EventJournal(wrapMemoryBackend(inner, {
      async listSessions() {
        const snapshot = await inner.listSessions();
        if (raceOnList) {
          raceOnList = false;
          await racingWriter.renameSession(targetSessionId, "Changed during no-op selection");
        }
        return snapshot;
      },
    }));
    const target = await journal.createSession("Already selected", await manifest("No-op head race"));
    targetSessionId = target.id;
    await selectProfileActiveConversation(journal, "research", target.id);
    const audited = (await journal.getSession(target.id))!;
    raceOnList = true;

    await expect(selectProfileActiveConversation(journal, "research", target.id, {
      expectedTargetHead: { sequence: audited.headSequence, digest: audited.headDigest },
    })).rejects.toBeInstanceOf(ProfileActiveConversationConflictError);

    expect((await journal.readEvents(target.id)).map((event) => event.type))
      .toEqual([
        "session.created",
        PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
        "session.renamed",
      ]);
  });

  it("returns the committed selection when cancellation arrives after storage admission", async () => {
    const inner = new MemoryJournalBackend();
    const controller = new AbortController();
    let abortAfterSelectionCommit = false;
    let selectionBackendSignal: AbortSignal | undefined | null = null;
    const journal = new EventJournal(wrapMemoryBackend(inner, {
      async append(sessionId, expectedHead, events, signal) {
        const committed = await inner.append(sessionId, expectedHead, events);
        if (
          abortAfterSelectionCommit
          && events.some((event) => event.type === PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE)
        ) {
          selectionBackendSignal = signal;
          abortAfterSelectionCommit = false;
          controller.abort(new DOMException("Stopped after admission", "AbortError"));
        }
        return committed;
      },
    }));
    const pinned = await manifest("Commit boundary");
    const target = await journal.createSession("Target", pinned);
    const audited = (await journal.getSession(target.id))!;
    abortAfterSelectionCommit = true;

    const selected = await selectProfileActiveConversation(journal, "research", target.id, {
      expectedTargetHead: { sequence: audited.headSequence, digest: audited.headDigest },
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(selectionBackendSignal).toBe(controller.signal);
    expect(selected).toMatchObject({
      changed: true,
      pointer: { sessionId: target.id, generation: 1 },
      session: { id: target.id, headSequence: audited.headSequence + 1 },
    });
    expect(await resolveProfileActiveConversation(journal, "research"))
      .toMatchObject({ state: "selected", pointer: { eventId: selected.pointer.eventId }, session: { id: target.id } });
  });

  it("forwards cancellation to a stalled profile session listing", async () => {
    const inner = new MemoryJournalBackend();
    const controller = new AbortController();
    let enteredList!: () => void;
    const listStarted = new Promise<void>((resolve) => { enteredList = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const journal = new EventJournal(wrapMemoryBackend(inner, {
      listSessions(signal) {
        receivedSignal = signal;
        enteredList();
        return new Promise<never>((_resolve, reject) => {
          const rejectFromAbort = () => reject(signal?.reason);
          if (signal?.aborted) rejectFromAbort();
          else signal?.addEventListener("abort", rejectFromAbort, { once: true });
        });
      },
    }));
    const target = await journal.createSession("Cancellation target", await manifest("List cancellation"));
    const audited = (await journal.getSession(target.id))!;

    const selection = selectProfileActiveConversation(journal, "research", target.id, {
      expectedTargetHead: { sequence: audited.headSequence, digest: audited.headDigest },
      signal: controller.signal,
    });
    await listStarted;
    expect(receivedSignal).toBe(controller.signal);
    controller.abort(new DOMException("Return request abandoned", "AbortError"));

    await expect(selection).rejects.toMatchObject({ name: "AbortError" });
    expect((await journal.readEvents(target.id)).map((event) => event.type))
      .toEqual(["session.created"]);
  });
});
