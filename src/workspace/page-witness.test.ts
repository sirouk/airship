import { describe, expect, it } from "vitest";
import {
  adoptWorkspaceWitness,
  clearWorkspaceWitness,
  dismissWorkspaceLoss,
  lostWorkspaceWorkNotice,
  readWorkspaceWitness,
  recordWorkspaceWork,
  WORKSPACE_PAGE_LOAD_ID,
  WORKSPACE_WITNESS_KEY_PREFIX,
  WORKSPACE_WITNESS_LIMIT,
  writeWorkspaceWitness,
} from "./page-witness";

function memoryStorage(): Storage & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (name: string) => entries.get(name) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (name: string) => { entries.delete(name); },
    setItem: (name: string, value: string) => { entries.set(name, value); },
  };
}

const SCOPE = "page-memory::general";

describe("the workbench's page witness", () => {
  it("records landed commits and saved paths under the load that made them", () => {
    const storage = memoryStorage();
    recordWorkspaceWork(storage, SCOPE, { commit: "docs: persist marker" });
    recordWorkspaceWork(storage, SCOPE, { savedPath: "/workspace/README.md" });
    const witness = readWorkspaceWitness(storage, SCOPE);
    expect(witness?.loadId).toBe(WORKSPACE_PAGE_LOAD_ID);
    expect(witness?.commits).toEqual(["docs: persist marker"]);
    expect(witness?.savedPaths).toEqual(["/workspace/README.md"]);
    expect(storage.entries.has(`${WORKSPACE_WITNESS_KEY_PREFIX}${SCOPE}`)).toBe(true);
  });

  it("counts a file saved twice as one file at risk", () => {
    const storage = memoryStorage();
    recordWorkspaceWork(storage, SCOPE, { savedPath: "/workspace/README.md" });
    recordWorkspaceWork(storage, SCOPE, { savedPath: "/workspace/README.md" });
    expect(readWorkspaceWitness(storage, SCOPE)?.savedPaths).toEqual(["/workspace/README.md"]);
  });

  it("keeps the record bounded so session storage never becomes a log", () => {
    const storage = memoryStorage();
    for (let index = 0; index < WORKSPACE_WITNESS_LIMIT + 10; index += 1) {
      recordWorkspaceWork(storage, SCOPE, { commit: `commit ${String(index)}` });
    }
    const witness = readWorkspaceWitness(storage, SCOPE);
    expect(witness?.commits).toHaveLength(WORKSPACE_WITNESS_LIMIT);
    expect(witness?.commits.at(-1)).toBe(`commit ${String(WORKSPACE_WITNESS_LIMIT + 9)}`);
  });

  it("carries the previous load's work forward as loss, and starts this load empty", () => {
    const storage = memoryStorage();
    writeWorkspaceWitness(storage, SCOPE, { loadId: "the-load-before", commits: ["docs: persist marker"], savedPaths: ["/workspace/README.md"] });
    const adopted = adoptWorkspaceWitness(readWorkspaceWitness(storage, SCOPE), WORKSPACE_PAGE_LOAD_ID);
    expect(adopted.loadId).toBe(WORKSPACE_PAGE_LOAD_ID);
    expect(adopted.commits).toEqual([]);
    expect(adopted.lost?.commits).toEqual(["docs: persist marker"]);
    expect(adopted.lost?.savedPaths).toEqual(["/workspace/README.md"]);
  });

  it("survives a remount and the first commit after it, so the loss cannot be silently deleted", () => {
    const storage = memoryStorage();
    writeWorkspaceWitness(storage, SCOPE, { loadId: "the-load-before", commits: ["docs: persist marker"], savedPaths: [] });
    writeWorkspaceWitness(storage, SCOPE, adoptWorkspaceWitness(readWorkspaceWitness(storage, SCOPE), WORKSPACE_PAGE_LOAD_ID));
    // Leaving the route and coming back re-adopts; the claim is still true.
    expect(adoptWorkspaceWitness(readWorkspaceWitness(storage, SCOPE), WORKSPACE_PAGE_LOAD_ID).lost?.commits)
      .toEqual(["docs: persist marker"]);
    recordWorkspaceWork(storage, SCOPE, { commit: "docs: second attempt" });
    const after = readWorkspaceWitness(storage, SCOPE);
    expect(after?.commits).toEqual(["docs: second attempt"]);
    expect(after?.lost?.commits).toEqual(["docs: persist marker"]);
  });

  it("retires the loss only when the reader dismisses it, keeping this load's own record", () => {
    const storage = memoryStorage();
    writeWorkspaceWitness(storage, SCOPE, { loadId: "the-load-before", commits: ["docs: persist marker"], savedPaths: [] });
    writeWorkspaceWitness(storage, SCOPE, adoptWorkspaceWitness(readWorkspaceWitness(storage, SCOPE), WORKSPACE_PAGE_LOAD_ID));
    recordWorkspaceWork(storage, SCOPE, { commit: "docs: second attempt" });
    dismissWorkspaceLoss(storage, SCOPE);
    const after = readWorkspaceWitness(storage, SCOPE);
    expect(after?.lost).toBeUndefined();
    expect(after?.commits).toEqual(["docs: second attempt"]);
  });

  it("claims nothing when the previous load did no work, or when the load is this one", () => {
    expect(adoptWorkspaceWitness({ loadId: "the-load-before", commits: [], savedPaths: [] }, WORKSPACE_PAGE_LOAD_ID).lost).toBeUndefined();
    const same = adoptWorkspaceWitness({ loadId: WORKSPACE_PAGE_LOAD_ID, commits: ["kept"], savedPaths: [] }, WORKSPACE_PAGE_LOAD_ID);
    expect(same.lost).toBeUndefined();
    expect(same.commits).toEqual(["kept"]);
    expect(adoptWorkspaceWitness(undefined, WORKSPACE_PAGE_LOAD_ID).lost).toBeUndefined();
  });

  it("names the work rather than only counting it", () => {
    expect(lostWorkspaceWorkNotice({ commits: ["docs: persist marker"], savedPaths: [] })).toBe(
      "1 commit this tab made existed only in page memory and did not survive the reload: “docs: persist marker”. It is not recoverable.",
    );
    expect(lostWorkspaceWorkNotice({ commits: ["docs: persist marker"], savedPaths: ["/workspace/README.md"] })).toBe(
      "1 commit and 1 saved file this tab made existed only in page memory and did not survive the reload: “docs: persist marker”, README.md. They are not recoverable.",
    );
    expect(lostWorkspaceWorkNotice({ commits: ["a", "b", "c", "d"], savedPaths: [] }))
      .toContain("and 1 more");
    expect(lostWorkspaceWorkNotice({ commits: [], savedPaths: [] })).toBeUndefined();
    expect(lostWorkspaceWorkNotice(undefined)).toBeUndefined();
  });

  it("survives a storage that refuses to answer rather than taking the workbench with it", () => {
    const hostile: Storage = {
      length: 0,
      clear: () => { throw new Error("denied"); },
      getItem: () => { throw new Error("denied"); },
      key: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readWorkspaceWitness(hostile, SCOPE)).toBeUndefined();
    expect(() => { recordWorkspaceWork(hostile, SCOPE, { commit: "x" }); }).not.toThrow();
    expect(() => { clearWorkspaceWitness(hostile, SCOPE); }).not.toThrow();
    expect(readWorkspaceWitness(undefined, SCOPE)).toBeUndefined();
  });

  it("adopting a Vault is the end of the claim: the record is removed, not kept", () => {
    const storage = memoryStorage();
    recordWorkspaceWork(storage, SCOPE, { commit: "docs: persist marker" });
    clearWorkspaceWitness(storage, SCOPE);
    expect(readWorkspaceWitness(storage, SCOPE)).toBeUndefined();
  });
});
