import { describe, expect, it } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import { MemoryWorkspace } from "../workspace/memory";
import { decodeWorkspaceBytes, encodeWorkspaceBytes } from "../workspace/content-codec";
import { mountTerminalWorkspace, reconcileTerminalWorkspace, syncTerminalWorkspace } from "./workspace-sync";

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
});

function mountedText(tree: FileSystemTree, path: string): string {
  const contents = (tree[path] as { file: { contents: Uint8Array | string } }).file.contents;
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}
