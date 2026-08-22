import { render } from "preact";
import { createBuiltInProfileCatalog } from "../../src/profiles/catalog";
import { RECALL_PATH, serializeRecallDocument } from "../../src/retrieval/recall-document";
import type { FederatedMemoryResult } from "../../src/tools/federated-memory";
import { MemoryView } from "../../src/ui/memory-view";
import { MemoryWorkspace } from "../../src/workspace/memory";

declare global {
  var airshipRecallDocument: () => Promise<string | undefined>;
}

/**
 * The Memory route over a workspace that already holds an ambient-recall index.
 *
 * The panel reads and writes `RECALL_PATH` through the ordinary WorkspacePort,
 * so a real MemoryWorkspace is the whole fixture: what the page shows and what
 * the switch writes are both observable from the test.
 */
export async function mountAmbientRecallHarness(root: Element): Promise<void> {
  const workspace = new MemoryWorkspace();
  await workspace.write(RECALL_PATH, serializeRecallDocument(Object.freeze({
    version: 1,
    enabled: true,
    cursors: Object.freeze({ "session-drinks": 6 }),
    excerpts: Object.freeze([
      Object.freeze({
        sessionId: "session-drinks", title: "Drinks", sequence: 2, who: "you" as const,
        at: "2026-08-01T09:15:00.000Z", text: "I like unicorn milk and I want it to be blue",
      }),
      Object.freeze({
        sessionId: "session-drinks", title: "Drinks", sequence: 5, who: "the agent" as const,
        at: "2026-08-01T09:15:04.000Z", text: "Blue it is.",
      }),
    ]),
  })));
  const catalog = await createBuiltInProfileCatalog();
  const activeProfile = catalog.profiles[0];
  if (!activeProfile) throw new Error("The test catalog has no profile.");
  const searchMemory = async (query: string): Promise<FederatedMemoryResult> => ({
    version: 1,
    query,
    queryDigest: "sha256:0000000000000000000000000000000000000000000",
    authority: { sessionId: "session-recall", profileId: activeProfile.profileId, profileRevision: activeProfile.revision },
    groups: [
      { corpus: "current-thread", priority: 1, ranking: "reverse-chronological lexical matches", hits: [] },
      { corpus: "active-profile-memory", priority: 2, ranking: "bounded BM25 relevance, recency-tiebroken; within this corpus only", legacyQuarantined: 0, hits: [] },
      { corpus: "shared-workspace-index", priority: 3, ranking: "hybrid score within this corpus only; never comparable across groups", duplicatesSuppressed: 0, hits: [] },
    ],
  });
  globalThis.airshipRecallDocument = async () => (await workspace.read(RECALL_PATH))?.content;
  render(
    <MemoryView
      sessionId="session-recall"
      messages={[]}
      files={await workspace.list()}
      catalog={catalog}
      activeProfile={activeProfile}
      workspace={workspace}
      searchMemory={searchMemory}
      initialTab="search"
    />,
    root,
  );
}
