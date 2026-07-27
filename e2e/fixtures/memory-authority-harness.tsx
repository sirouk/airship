import { render } from "preact";
import { createBuiltInProfileCatalog } from "../../src/profiles/catalog";
import { getClientContextRuntime } from "../../src/retrieval/client-context-runtime";
import type { FederatedMemoryResult } from "../../src/tools/federated-memory";
import { MemoryView } from "../../src/ui/memory-view";
import { MemoryWorkspace } from "../../src/workspace/memory";

declare global {
  var airshipMemoryAuthorityInvocations: number;
  var airshipMemoryAuthorityUpdate: () => Promise<void>;
}

export async function mountSlowMemoryAuthorityHarness(root: Element): Promise<void> {
  const workspace = new MemoryWorkspace();
  await workspace.write("/workspace/docs/slow.md", "workspace slow authority result");
  const catalog = await createBuiltInProfileCatalog();
  const activeProfile = catalog.profiles[0];
  if (!activeProfile) throw new Error("The test catalog has no profile.");
  globalThis.airshipMemoryAuthorityInvocations = 0;
  const runtime = getClientContextRuntime(workspace);
  const runtimeSearch = runtime.search.bind(runtime);
  runtime.search = async (query, options) => {
    globalThis.airshipMemoryAuthorityInvocations += 1;
    await abortableDelay(650, options.signal ?? new AbortController().signal);
    return runtimeSearch(query, options);
  };
  const searchMemory = async (query: string, signal: AbortSignal): Promise<FederatedMemoryResult> => {
    const workspaceResult = await runtime.search(query, { limit: 8, signal });
    return {
      version: 1,
      query,
      queryDigest: workspaceResult.queryDigest,
      authority: {
        sessionId: "session-slow",
        profileId: activeProfile.profileId,
        profileRevision: activeProfile.revision,
      },
      groups: [
        {
          corpus: "current-thread",
          priority: 1,
          ranking: "reverse-chronological lexical matches",
          hits: [],
        },
        {
          corpus: "active-profile-memory",
          priority: 2,
          ranking: "bounded BM25 relevance, recency-tiebroken; within this corpus only",
          legacyQuarantined: 0,
          hits: [],
        },
        {
          corpus: "shared-workspace-index",
          priority: 3,
          ranking: "hybrid score within this corpus only; never comparable across groups",
          generationDigest: workspaceResult.generationDigest,
          workspaceSnapshotDigest: workspaceResult.workspaceSnapshotDigest,
          durationMs: workspaceResult.durationMs,
          completedAt: workspaceResult.completedAt,
          duplicatesSuppressed: 0,
          hits: workspaceResult.hits.map((hit) => ({
            ...hit,
            scoreScope: "shared-workspace-index-only",
          })),
        },
      ],
    };
  };
  const mount = async () => render(
    <MemoryView sessionId="session-slow" messages={[]} files={await workspace.list()} catalog={catalog} activeProfile={activeProfile} workspace={workspace} searchMemory={searchMemory} initialTab="index" />,
    root,
  );
  globalThis.airshipMemoryAuthorityUpdate = async () => {
    await workspace.write("/workspace/docs/slow.md", "workspace slow refreshed authority");
    await mount();
  };
  await mount();
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
