import { describe, expect, it } from "vitest";
import { LOCAL_FOLDER_MOUNT_ROOT } from "../workspace/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { ClientContextEngine } from "./client-context-engine";

describe("the derived index and an attached folder", () => {
  /*
   * The generation this engine builds is page memory, but "Publish context"
   * writes its chunks — file text included — into the Vault. The
   * attached-folder tier promises the folder is copied nowhere, so the folder
   * must not enter the index at either door: the entries the engine is handed,
   * and the re-listing it validates them against.
   */
  it("indexes the workspace and never a folder the person attached", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/README.md", "workspace content");
    await workspace.write(`${LOCAL_FOLDER_MOUNT_ROOT}/airship/notes.md`, "content from this device");
    const engine = new ClientContextEngine({ workspace });
    const generation = await engine.updateWorkspace(await workspace.list("/workspace"));
    const indexed = generation.candidates.map((candidate) => candidate.path);
    expect(indexed).toContain("/workspace/README.md");
    expect(indexed.some((path) => path.startsWith(LOCAL_FOLDER_MOUNT_ROOT))).toBe(false);
  });
});
