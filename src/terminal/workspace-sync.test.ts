import { describe, expect, it } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import { MemoryWorkspace } from "../workspace/memory";
import { mountTerminalWorkspace, syncTerminalWorkspace } from "./workspace-sync";

describe("terminal workspace synchronization", () => {
  it("mounts bounded user files, excludes control state, and adopts revision-fenced changes", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "before\n", { expectedRevision: null });
    await workspace.write(".airship/terminal/sessions.v1.json", "private metadata", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; } },
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
      fs: { async mkdir() { return undefined; } },
      async mount(tree: FileSystemTree, _options: { mountPoint: string }) { mounted = structuredClone(tree); },
      async export(_path: string, _options: { format: "json"; excludes: string[] }) { return { ...mounted, "README.md": { file: { contents: "terminal\n" } } } satisfies FileSystemTree; },
    };
    const baseline = await mountTerminalWorkspace(host, workspace);
    await workspace.write("README.md", "outside\n", { expectedRevision: initial.revision });

    await expect(syncTerminalWorkspace(host, workspace, baseline)).rejects.toThrow("conflicts with the current workspace revision");
    await expect(workspace.read("README.md")).resolves.toMatchObject({ content: "outside\n" });
  });
});
