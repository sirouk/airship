import { describe, expect, it, vi } from "vitest";
import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import { MemoryWorkspace } from "../workspace/memory";
import { executeNodeProject } from "./node-webcontainer-adapter";

describe("Node WebContainer adapter", () => {
  it("mounts a bounded project snapshot and adopts checked text changes only when requested", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/package.json", '{"scripts":{"build":"node index.js"}}');
    await workspace.write("/workspace/app/index.js", "console.log('before')\n");
    let mounted: FileSystemTree | undefined;
    const container = fakeContainer({
      mount(tree) {
        mounted = tree;
      },
      exported: {
        "package.json": { file: { contents: '{"scripts":{"build":"node index.js"}}' } },
        "index.js": { file: { contents: "console.log('after')\n" } },
        "build.txt": { file: { contents: "browser-built\n" } },
      },
    });

    const result = await executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "npm",
      args: ["run", "build"],
      timeoutMs: 5_000,
      writeBack: true,
      signal: new AbortController().signal,
    });

    expect(mounted).toMatchObject({
      "package.json": { file: { contents: expect.stringContaining("build") } },
      "index.js": { file: { contents: "console.log('before')\n" } },
    });
    expect(result).toMatchObject({ runtime: "node-webcontainer", exitCode: 0, stdout: "node-ready\n" });
    expect(result.value).toMatchObject({ adopted: true, outputStream: "combined" });
    expect(await workspace.read("/workspace/app/index.js")).toMatchObject({ content: "console.log('after')\n" });
    expect(await workspace.read("/workspace/app/build.txt")).toMatchObject({ content: "browser-built\n" });
  });

  it("reports deltas without mutating Airship when write-back is disabled", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/index.js", "before\n");
    const container = fakeContainer({
      exported: { "index.js": { file: { contents: "after\n" } } },
    });
    const result = await executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(await workspace.read("/workspace/app/index.js")).toMatchObject({ content: "before\n" });
    expect(result.value).toMatchObject({ adopted: false, changes: [{ kind: "modify" }] });
  });

  it("never routes a shell expression or path through a hidden shell", async () => {
    const workspace = new MemoryWorkspace();
    await expect(executeNodeProject(fakeContainer({ exported: {} }), {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace",
      command: "npm && curl",
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/direct command name/u);
  });

  it("never adopts workspace output from a failed command", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/index.js", "before\n");
    const container = fakeContainer({
      exitCode: 1,
      exported: { "index.js": { file: { contents: "after\n" } } },
    });
    const result = await executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      writeBack: true,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: 1, value: { adopted: false } });
    expect(await workspace.read("/workspace/app/index.js")).toMatchObject({ content: "before\n" });
  });
});

function fakeContainer(options: Readonly<{
  exported: FileSystemTree;
  mount?(tree: FileSystemTree): void;
  exitCode?: number;
}>): Pick<WebContainer, "export" | "fs" | "mount" | "spawn"> {
  return {
    fs: {
      mkdir: vi.fn(async () => "jobs"),
      rm: vi.fn(async () => undefined),
    } as unknown as WebContainer["fs"],
    async mount(tree: FileSystemTree | Uint8Array | ArrayBuffer) {
      if (!(tree instanceof Uint8Array) && !(tree instanceof ArrayBuffer)) options.mount?.(tree);
    },
    async spawn() {
      return {
        exit: Promise.resolve(options.exitCode ?? 0),
        input: new WritableStream<string>(),
        output: new ReadableStream<string>({
          start(controller) {
            controller.enqueue("node-ready\n");
            controller.close();
          },
        }),
        kill: vi.fn(),
        resize: vi.fn(),
      } satisfies WebContainerProcess;
    },
    async export() {
      return options.exported;
    },
  } as unknown as Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;
}
