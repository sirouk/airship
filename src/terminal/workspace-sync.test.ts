import { describe, expect, it } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import { MemoryWorkspace } from "../workspace/memory";
import { decodeWorkspaceBytes, encodeWorkspaceBytes } from "../workspace/content-codec";
import { ATTACHED_FOLDER_REFUSAL, mountTerminalWorkspace, reconcileTerminalWorkspace, syncTerminalWorkspace } from "./workspace-sync";

describe("terminal workspace synchronization", () => {
  it("mounts bounded user files, excludes control state, and adopts revision-fenced changes", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "before\n", { expectedRevision: null });
    await workspace.write(".airship/terminal/sessions.v1.json", "private metadata", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree, _options: { mountPoint: string }) { mounted = structuredClone(tree); },
      async export(_path: string, _options: { format: "json"; excludes: string[] }) {
        return {
          ...mounted,
          "README.md": { file: { contents: "after\n" } },
          "new.txt": { file: { contents: "created\n" } },
        } satisfies FileSystemTree;
      },
    };

    const baseline = await mountTerminalWorkspace(host, workspace);
    expect(mounted).toHaveProperty("README.md");
    expect(mounted).not.toHaveProperty(".airship");
    const result = await syncTerminalWorkspace(host, workspace, baseline);

    await expect(workspace.read("README.md")).resolves.toMatchObject({ content: "after\n" });
    await expect(workspace.read("new.txt")).resolves.toMatchObject({ content: "created\n" });
    expect(result.changedPaths).toEqual(["/workspace/README.md", "/workspace/new.txt"]);
  });

  it("refuses to overwrite a workspace revision changed outside the hot process", async () => {
    const workspace = new MemoryWorkspace();
    const initial = await workspace.write("README.md", "before\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree, _options: { mountPoint: string }) { mounted = structuredClone(tree); },
      async export(_path: string, _options: { format: "json"; excludes: string[] }) { return { ...mounted, "README.md": { file: { contents: "terminal\n" } } } satisfies FileSystemTree; },
    };
    const baseline = await mountTerminalWorkspace(host, workspace);
    await workspace.write("README.md", "outside\n", { expectedRevision: initial.revision });

    await expect(syncTerminalWorkspace(host, workspace, baseline)).rejects.toThrow("conflicts with the current workspace revision");
    await expect(workspace.read("README.md")).resolves.toMatchObject({ content: "outside\n" });
  });

  it("adopts terminal deltas and remounts later Editor revisions into the hot runtime", async () => {
    const workspace = new MemoryWorkspace();
    const original = await workspace.write("README.md", "before\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
    };
    const baseline = await mountTerminalWorkspace(host, workspace);
    await workspace.write("README.md", "from editor\n", { expectedRevision: original.revision });
    await workspace.write("editor-only.txt", "visible after reconcile\n", { expectedRevision: null });

    const reconciled = await reconcileTerminalWorkspace(host, workspace, baseline);

    expect(reconciled.changedPaths).toEqual([]);
    expect(mountedText(mounted, "README.md")).toBe("from editor\n");
    expect(mountedText(mounted, "editor-only.txt")).toBe("visible after reconcile\n");
  });

  it("leaves a later Editor revision alone across two syncs that never rebuild the mount", async () => {
    const workspace = new MemoryWorkspace();
    const original = await workspace.write("README.md", "before\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
    };
    const baseline = await mountTerminalWorkspace(host, workspace);
    await workspace.write("README.md", "from editor\n", { expectedRevision: original.revision });

    // Sync without remounting: the mount still holds "before\n", so the next
    // sync must not read that stale copy as a terminal edit and publish it.
    const first = await syncTerminalWorkspace(host, workspace, baseline);
    const second = await syncTerminalWorkspace(host, workspace, first.snapshot);

    expect(first.changedPaths).toEqual([]);
    expect(second.changedPaths).toEqual([]);
    await expect(workspace.read("README.md")).resolves.toMatchObject({ content: "from editor\n" });
  });

  it("leaves an Editor deletion deleted across two syncs that never rebuild the mount", async () => {
    const workspace = new MemoryWorkspace();
    const original = await workspace.write("gone.txt", "before\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
    };
    const baseline = await mountTerminalWorkspace(host, workspace);
    await workspace.remove("gone.txt", { expectedRevision: original.revision });

    const first = await syncTerminalWorkspace(host, workspace, baseline);
    const second = await syncTerminalWorkspace(host, workspace, first.snapshot);

    expect(second.changedPaths).toEqual([]);
    await expect(workspace.read("gone.txt")).resolves.toBeUndefined();
  });

  it("does not fail a whole sync because the Editor already deleted what the terminal deleted", async () => {
    const workspace = new MemoryWorkspace();
    const doomed = await workspace.write("gone.txt", "before\n", { expectedRevision: null });
    await workspace.write("kept.txt", "before\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
    };
    const baseline = await mountTerminalWorkspace(host, workspace);
    await workspace.remove("gone.txt", { expectedRevision: doomed.revision });
    // The shell removed the same file, and edited an unrelated one.
    delete (mounted as Record<string, unknown>)["gone.txt"];
    mounted["kept.txt"] = { file: { contents: "from terminal\n" } };

    const result = await syncTerminalWorkspace(host, workspace, baseline);

    expect(result.changedPaths).toEqual(["/workspace/kept.txt"]);
    await expect(workspace.read("kept.txt")).resolves.toMatchObject({ content: "from terminal\n" });
    await expect(workspace.read("gone.txt")).resolves.toBeUndefined();
  });

  it("round-trips opaque Git worktree bytes without mounting the storage envelope", async () => {
    const workspace = new MemoryWorkspace();
    const original = Uint8Array.from([0, 255, 1, 2, 128, 64]);
    await workspace.write("asset.bin", encodeWorkspaceBytes(original), { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
    };

    const baseline = await mountTerminalWorkspace(host, workspace);
    const mountedBytes = (mounted["asset.bin"] as { file: { contents: Uint8Array } }).file.contents;
    expect([...mountedBytes]).toEqual([...original]);
    expect(new TextDecoder().decode(mountedBytes)).not.toContain("airship-git-binary-v1:");

    mountedBytes[2] = 9;
    await syncTerminalWorkspace(host, workspace, baseline);
    expect([...decodeWorkspaceBytes((await workspace.read("asset.bin"))!.content)]).toEqual([0, 255, 9, 2, 128, 64]);
  });

  /*
   * F4. The Terminal copies the workspace into a WebContainer and writes the
   * result back through `workspace.write` — outside the approval broker. When
   * a folder from this device is composed into `/workspace/local`, that copy
   * was the person's own directory going into a Node sandbox, and the write
   * back was shell output landing on their real files with nothing to approve.
   */
  it("never mounts the folder attached from this device, and refuses shell output addressed to it", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "before\n", { expectedRevision: null });
    await workspace.write("local/airship/secrets.env", "OPENAI_API_KEY=real\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    let exported: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree, _options: { mountPoint: string }) { mounted = structuredClone(tree); },
      async export(_path: string, _options: { format: "json"; excludes: string[] }) { return structuredClone(exported); },
    };

    const baseline = await mountTerminalWorkspace(host, workspace);
    // The real folder is not copied into the sandbox at all.
    expect(mounted).toHaveProperty("README.md");
    expect(mounted).not.toHaveProperty("local");
    expect([...baseline.files.keys()]).toEqual(["README.md"]);

    // And a command that writes into it is refused rather than applied.
    exported = { ...mounted, local: { directory: { "airship": { directory: { "secrets.env": { file: { contents: "OPENAI_API_KEY=stolen\n" } } } } } } };
    await expect(syncTerminalWorkspace(host, workspace, baseline))
      .rejects.toThrow(/does not carry the folder you attached from this device/u);
    /*
     * The sentence has to be true of the path it sends a person to. A workbench
     * save writes straight through the workspace port with no broker — the same
     * port the Terminal writes through — so "every write to it is reviewed" was
     * false. What that path does have is a person choosing each file and
     * pressing Save, and an agent write that is reviewed in every approval mode.
     */
    await expect(syncTerminalWorkspace(host, workspace, baseline))
      .rejects.toThrow(/where you save it yourself and every agent write to it is reviewed/u);
    expect(ATTACHED_FOLDER_REFUSAL).not.toContain("where every write to it is reviewed");
    await expect(syncTerminalWorkspace(host, workspace, baseline))
      .rejects.toThrow(/Refused: \/workspace\/local\/airship\/secrets\.env/u);
    // The real file is untouched.
    await expect(workspace.read("local/airship/secrets.env")).resolves.toMatchObject({
      content: encodeWorkspaceBytes(new TextEncoder().encode("OPENAI_API_KEY=real\n")),
    });
  });
});

function mountedText(tree: FileSystemTree, path: string): string {
  const contents = (tree[path] as { file: { contents: Uint8Array | string } }).file.contents;
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}
