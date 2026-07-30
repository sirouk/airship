import { describe, expect, it } from "vitest";
import { ClientContextStaleSnapshotError } from "../indexing/client-context-engine";
import { WorkspaceRefreshCoordinator } from "../ui/workspace-refresh";
import { MemoryWorkspace } from "../workspace/memory";
import type { WorkspaceEntry } from "../workspace/contracts";
import { ClientContextRuntime } from "./client-context-runtime";

/**
 * The array the shell publishes is the array the index engine validates.
 *
 * `workspaceFiles` serves two roles that were quietly incompatible: it is a
 * presentation input for the Memory and Context routes, and it is the *revision
 * snapshot* ContextView hands to the engine, which re-lists the live workspace
 * and raises `CONTEXT_SNAPSHOT_STALE` on any difference. A 2,000-entry
 * presentation cap at the publish seam therefore asserted that every larger
 * workspace had changed underneath the engine, so such a workspace could never
 * be indexed at all — the cap was not defending an engine bound either, since
 * the engine's own limit is 250,000 entries.
 *
 * This drives the real seam (`WorkspaceRefreshCoordinator`, whose published
 * array app.tsx forwards verbatim) against a workspace one entry past the old
 * cap, and pins both directions: the published array must validate, and the
 * truncated array must not. The second assertion is the regression pin — it is
 * the failure the cap produced, so if a bound is ever reintroduced anywhere
 * between the coordinator and `updateWorkspace`, the first assertion breaks
 * with exactly the error named here.
 */
const PRESENTATION_CAP = 2_000;
const ENTRIES = PRESENTATION_CAP + 1;

describe("workspace revision snapshot authority", () => {
  it("indexes a workspace one entry past the old presentation cap", async () => {
    const workspace = await seedWorkspace(ENTRIES);
    const published = await publishLikeTheShell(workspace);
    expect(published).toHaveLength(ENTRIES);

    const runtime = new ClientContextRuntime(workspace, { dimensions: 32, maxChunkCharacters: 256 });
    const generation = await runtime.updateWorkspace(published);

    expect(runtime.getState().phase).toBe("ready");
    expect(runtime.getState().error).toBeUndefined();
    expect(generation.candidates).toHaveLength(ENTRIES);
  }, 120_000);

  it("rejects the truncated array the publish seam used to hand the engine", async () => {
    const workspace = await seedWorkspace(ENTRIES);
    const published = await publishLikeTheShell(workspace);
    const capped = published.slice(0, PRESENTATION_CAP);

    const runtime = new ClientContextRuntime(workspace, { dimensions: 32, maxChunkCharacters: 256 });
    // `assertWorkspaceSnapshot` re-lists the live workspace and compares keys,
    // so a snapshot short by one entry is indistinguishable from a file that
    // vanished mid-refresh. That is the whole defect: a bound applied at the
    // publish seam is read by the engine as evidence of concurrent change.
    await expect(runtime.updateWorkspace(capped)).rejects.toBeInstanceOf(ClientContextStaleSnapshotError);
    expect(runtime.getState().phase).toBe("error");
  }, 120_000);
});

async function seedWorkspace(count: number): Promise<MemoryWorkspace> {
  const workspace = new MemoryWorkspace();
  for (let index = 0; index < count; index += 1) {
    await workspace.write(`notes/entry-${String(index).padStart(5, "0")}.md`, `entry ${index}`);
  }
  return workspace;
}

/**
 * The publish path the shell actually runs: list, drop control-plane paths,
 * hand the whole array on. app.tsx's callback is `setWorkspaceFiles([...entries])`,
 * so what the coordinator publishes is what ContextView forwards to the engine.
 */
async function publishLikeTheShell(workspace: MemoryWorkspace): Promise<readonly WorkspaceEntry[]> {
  const authority = Object.freeze({ workspace, workspaceId: "memory", profileId: "general" });
  let published: readonly WorkspaceEntry[] = [];
  const refreshed = await new WorkspaceRefreshCoordinator().refresh(
    authority,
    () => authority,
    (entries) => { published = [...entries]; },
  );
  expect(refreshed).toBe(true);
  return published;
}
