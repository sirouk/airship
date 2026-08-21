import { render } from "preact";
import { EventJournal, type SessionRecord } from "../../src/core/journal";
import { MemoryJournalBackend } from "../../src/core/memory-journal";
import { createSessionManifest } from "../../src/core/session-manifest";
import { SessionLibrary } from "../../src/sessions/library";
import { SessionsView } from "../../src/ui/sessions-view";

declare global {
  var airshipSlowSessionListRelease: () => void;
  var airshipSlowSessionListReads: number;
}

const PROFILE = "harness-profile";

/**
 * The sessions route with one conversation in the journal and a list read that
 * lands only when the test says so.
 *
 * The race this exists for is the ordinary one: the route starts its journal
 * read on mount, the move-work panel is a lazily fetched chunk, and on a warm
 * cache the panel is on screen first. Holding the read open makes that window
 * a fact instead of a coin toss.
 */
export async function mountSlowSessionListHarness(root: Element): Promise<void> {
  const backend = new MemoryJournalBackend();
  const journal = new EventJournal(backend);
  const manifest = await createSessionManifest({
    systemPrompt: "harness",
    providerId: "demo",
    model: "demo-model",
    tools: [],
    workspaceId: "harness-workspace",
    // The route scopes its read to the active profile, so the one conversation
    // in this journal has to be pinned to it or the list is honestly empty.
    profile: {
      version: 2,
      profileId: PROFILE,
      profileRevision: "1",
      themeId: "harness-theme",
      themeDigest: "sha256:harness-theme",
      resolvedSkills: [],
      skillSetDigest: "sha256:harness-skills",
      resolutionDigest: "sha256:harness-resolution",
      workspaceBinding: { kind: "active-workspace" },
      memoryScope: "profile",
      approvalMode: "ask-first",
    },
  });
  await journal.createSession("Only conversation", manifest);
  const held = new Promise<void>((resolve) => {
    globalThis.airshipSlowSessionListRelease = resolve;
  });
  globalThis.airshipSlowSessionListReads = 0;
  const listSessions = journal.listSessions.bind(journal);
  journal.listSessions = async (signal?: AbortSignal): Promise<SessionRecord[]> => {
    globalThis.airshipSlowSessionListReads += 1;
    if (globalThis.airshipSlowSessionListReads === 1) await held;
    return listSessions(signal);
  };
  render(
    <SessionsView
      library={new SessionLibrary(journal)}
      scopeProfileId={PROFILE}
      scopeProfileName="Harness"
      onResume={() => undefined}
      bundleSources={{ journal, journalStorage: backend, authoritySettled: true }}
    />,
    root,
  );
}
