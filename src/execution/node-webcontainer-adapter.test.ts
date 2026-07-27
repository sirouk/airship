import { describe, expect, it, vi } from "vitest";
import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import { MemoryWorkspace } from "../workspace/memory";
import { decodeWorkspaceBytes, encodeWorkspaceBytes } from "../workspace/content-codec";
import { createNodeWebContainerAdapter, executeNodeProject } from "./node-webcontainer-adapter";

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
      "package.json": { file: { contents: expect.any(Uint8Array) } },
      "index.js": { file: { contents: expect.any(Uint8Array) } },
    });
    const mountedIndex = mounted?.["index.js"];
    expect(mountedIndex && "file" in mountedIndex && "contents" in mountedIndex.file
      ? new TextDecoder().decode(mountedIndex.file.contents as Uint8Array)
      : undefined).toBe("console.log('before')\n");
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

  it("restores unadopted outputs while retaining the page-local project", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/index.js", "before\n");
    const rm = vi.fn(async () => undefined);
    const mount = vi.fn(async () => undefined);
    const container = {
      fs: {
        mkdir: vi.fn(async () => "jobs"),
        rm,
      },
      mount,
      spawn: vi.fn(async () => processResult(0, "generated\n")),
      export: vi.fn(async () => ({
        "index.js": { file: { contents: "after\n" } },
        "unadopted.txt": { file: { contents: "temporary\n" } },
      })),
    } as unknown as Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;

    const result = await executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      writeBack: false,
      signal: new AbortController().signal,
    });

    expect(result.value).toMatchObject({ adopted: false });
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/\/unadopted\.txt$/u), {
      force: true,
      recursive: true,
    });
    expect(mount).toHaveBeenCalledTimes(2);
    expect(await workspace.read("/workspace/app/index.js")).toMatchObject({ content: "before\n" });
    expect(await workspace.read("/workspace/app/unadopted.txt")).toBeUndefined();
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

  it("round-trips opaque workspace bytes without executing the envelope text", async () => {
    const workspace = new MemoryWorkspace();
    const before = new Uint8Array([0, 255, 1, 2, 128]);
    const after = new Uint8Array([0, 254, 3, 4, 129]);
    await workspace.write("/workspace/app/blob.bin", encodeWorkspaceBytes(before));
    let mounted: FileSystemTree | undefined;
    const container = fakeContainer({
      mount(tree) { mounted = tree; },
      exported: { "blob.bin": { file: { contents: after } } },
    });

    await executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["noop.js"],
      timeoutMs: 5_000,
      writeBack: true,
      signal: new AbortController().signal,
    });

    const mountedBlob = mounted?.["blob.bin"];
    expect(mountedBlob && "file" in mountedBlob && "contents" in mountedBlob.file
      ? [...mountedBlob.file.contents as Uint8Array]
      : undefined).toEqual([...before]);
    expect([...(decodeWorkspaceBytes((await workspace.read("/workspace/app/blob.bin"))!.content))]).toEqual([...after]);
  });

  it("keeps the execution deadline active until the provider output stream closes", async () => {
    const workspace = new MemoryWorkspace();
    const kill = vi.fn();
    const container = {
      fs: {
        mkdir: vi.fn(async () => "jobs"),
        rm: vi.fn(async () => undefined),
      },
      async mount() {},
      async spawn() {
        return {
          exit: Promise.resolve(0),
          input: new WritableStream<string>(),
          output: new ReadableStream<string>({
            start(controller) { controller.enqueue("partial output"); },
          }),
          kill,
          resize() {},
        };
      },
      async export() { return {}; },
    } as unknown as Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;

    await expect(executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace",
      command: "node",
      args: ["index.js"],
      timeoutMs: 20,
      signal: new AbortController().signal,
    })).rejects.toThrow(/Node execution exceeded \d+ ms/u);
    expect(kill).toHaveBeenCalled();
  });

  it("does not strand a completed npm process when the provider stream omits EOF", async () => {
    vi.useFakeTimers();
    try {
      const workspace = new MemoryWorkspace();
      await workspace.write("/workspace/app/package.json", '{"name":"stream-drain"}');
      let markSpawnStarted!: () => void;
      const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
      const container = fakeContainer({
        exported: {
          "package.json": { file: { contents: '{"name":"stream-drain"}' } },
        },
        async spawn() {
          markSpawnStarted();
          return {
            ...processResult(0, ""),
            output: new ReadableStream<string>({
              start(controller) { controller.enqueue("installed\n"); },
            }),
          };
        },
      });
      const execution = executeNodeProject(container, {
        runtime: "node-webcontainer",
        workspace,
        workspaceRoot: "/workspace/app",
        command: "npm",
        args: ["install"],
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });

      await spawnStarted;
      for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(execution).resolves.toMatchObject({ exitCode: 0, stdout: "installed\n" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps installed dependencies in one page-local project across sequential tool calls", async () => {
    const workspace = new MemoryWorkspace();
    const packageJson = '{"scripts":{"build":"vite build"},"devDependencies":{"vite":"8.0.13"}}';
    await workspace.write("/workspace/vite/package.json", packageJson);
    await workspace.write("/workspace/vite/index.html", '<div id="app"></div>');
    await workspace.write("/workspace/vite/main.js", "document.querySelector('#app').textContent = 'Hello Airship';");
    const installedRoots = new Set<string>();
    const spawnedRoots: string[] = [];
    let commandIndex = 0;
    const container = fakeContainer({
      exported: {},
      async spawn(command, args, cwd) {
        spawnedRoots.push(cwd);
        commandIndex += 1;
        if (command === "npm" && args[0] === "install") installedRoots.add(cwd);
        const buildSucceeded = command !== "npm" || args[0] !== "run" || installedRoots.has(cwd);
        return processResult(buildSucceeded ? 0 : 1, buildSucceeded ? "ok\n" : "vite: not found\n");
      },
      export() {
        return commandIndex === 1
          ? {
            "package.json": { file: { contents: packageJson } },
            "index.html": { file: { contents: '<div id="app"></div>' } },
            "main.js": { file: { contents: "document.querySelector('#app').textContent = 'Hello Airship';" } },
          } as FileSystemTree
          : {
            "package.json": { file: { contents: packageJson } },
            "index.html": { file: { contents: '<div id="app"></div>' } },
            "main.js": { file: { contents: "document.querySelector('#app').textContent = 'Hello Airship';" } },
            "dist": { directory: {
              "index.html": { file: { contents: '<div id="app">Hello Airship</div>' } },
            } },
          } as FileSystemTree;
      },
    });
    const adapter = createNodeWebContainerAdapter(container);
    const context = {
      runtime: "node-webcontainer" as const,
      workspace,
      workspaceRoot: "/workspace/vite",
      command: "npm",
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    };

    const install = await adapter.execute({ ...context, args: ["install"] });
    const build = await adapter.execute({ ...context, args: ["run", "build"], writeBack: true });

    expect(install.exitCode).toBe(0);
    expect(build.exitCode).toBe(0);
    expect(spawnedRoots).toHaveLength(2);
    expect(spawnedRoots[1]).toBe(spawnedRoots[0]);
    expect(build.value).toMatchObject({
      projectLifetime: "page",
      dependencyPersistence: "ephemeral-page",
      excludedPersistentPaths: ["node_modules"],
    });
    expect(await workspace.read("/workspace/vite/dist/index.html")).toMatchObject({
      content: '<div id="app">Hello Airship</div>',
    });
  });

  it("does not start an execution that was cancelled while queued", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/index.js", "console.log('ready')\n");
    let finishFirst!: (code: number) => void;
    const firstExit = new Promise<number>((resolve) => { finishFirst = resolve; });
    const spawn = vi.fn()
      .mockResolvedValueOnce({
        ...processResult(0, ""),
        exit: firstExit,
      } satisfies WebContainerProcess)
      .mockResolvedValue(processResult(0, "unexpected\n"));
    const container = fakeContainer({
      exported: { "index.js": { file: { contents: "console.log('ready')\n" } } },
      spawn: async (command, args, cwd) => spawn(command, args, cwd),
    });
    const adapter = createNodeWebContainerAdapter(container);
    const first = adapter.execute({
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const secondController = new AbortController();
    const second = adapter.execute({
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      signal: secondController.signal,
    });
    secondController.abort(new DOMException("Cancelled in queue", "AbortError"));
    finishFirst(0);

    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("invalidates the host when a killed process never confirms exit", async () => {
    vi.useFakeTimers();
    try {
      const workspace = new MemoryWorkspace();
      await workspace.write("/workspace/app/index.js", "console.log('stuck')\n");
      const kill = vi.fn();
      const invalidateHost = vi.fn(async () => undefined);
      let markSpawnStarted!: () => void;
      const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
      const spawn = vi.fn(async () => {
        markSpawnStarted();
        return {
          ...processResult(0, ""),
          exit: new Promise<number>(() => undefined),
          output: new ReadableStream<string>({ start() {} }),
          kill,
        } satisfies WebContainerProcess;
      });
      const container = {
        fs: {
          mkdir: vi.fn(async () => "jobs"),
          rm: vi.fn(async () => undefined),
        },
        mount: vi.fn(async () => undefined),
        spawn,
        export: vi.fn(async () => ({})),
      } as unknown as Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;
      const adapter = createNodeWebContainerAdapter(container, { invalidateHost });
      const execution = adapter.execute({
        runtime: "node-webcontainer",
        workspace,
        workspaceRoot: "/workspace/app",
        command: "node",
        args: ["index.js"],
        timeoutMs: 100,
        signal: new AbortController().signal,
      });
      const outcome = execution.then(
        () => new Error("Execution unexpectedly completed."),
        (error: unknown) => error,
      );

      await spawnStarted;
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toMatchObject({
        name: "NodeProcessTerminationUnconfirmedError",
      });
      expect(kill).toHaveBeenCalled();
      expect(invalidateHost).toHaveBeenCalledOnce();
      await expect(adapter.execute({
        runtime: "node-webcontainer",
        workspace,
        workspaceRoot: "/workspace/app",
        command: "node",
        args: ["index.js"],
        timeoutMs: 100,
        signal: new AbortController().signal,
      })).rejects.toThrow(/host was invalidated/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never exports or adopts after cancellation and invalidates an in-flight provider phase", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/index.js", "before\n");
    let releaseExport!: (tree: FileSystemTree) => void;
    let markExportStarted!: () => void;
    const exportStarted = new Promise<void>((resolve) => { markExportStarted = resolve; });
    const invalidateHost = vi.fn(async () => undefined);
    const container = fakeContainer({
      exported: {},
      export: () => {
        markExportStarted();
        return new Promise<FileSystemTree>((resolve) => { releaseExport = resolve; });
      },
    });
    const controller = new AbortController();
    const adapter = createNodeWebContainerAdapter(container, { invalidateHost });
    const execution = adapter.execute({
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      writeBack: true,
      signal: controller.signal,
    });

    await exportStarted;
    controller.abort(new DOMException("Stopped before writeback", "AbortError"));
    await expect(execution).rejects.toThrow(/workspace export did not complete safely/u);
    releaseExport({ "index.js": { file: { contents: "after\n" } } });
    expect(invalidateHost).toHaveBeenCalledOnce();
    expect(await workspace.read("/workspace/app/index.js")).toMatchObject({ content: "before\n" });
  });

  it("rejects an oversized file reported by a bounded read even when its content was truncated", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/large.bin", "placeholder");
    const metadataOnlyWorkspace = {
      list: async () => [{
        path: "/workspace/app/large.bin",
        revision: "large-revision",
        updatedAt: new Date().toISOString(),
        size: 1,
      }],
      read: vi.fn(async () => undefined),
      readBounded: vi.fn(async () => ({
        path: "/workspace/app/large.bin",
        revision: "large-revision",
        updatedAt: new Date().toISOString(),
        size: 2 * 1024 * 1024 + 1,
        content: "",
      })),
      write: workspace.write.bind(workspace),
      remove: workspace.remove.bind(workspace),
    };

    await expect(executeNodeProject(fakeContainer({ exported: {} }), {
      runtime: "node-webcontainer",
      workspace: metadataOnlyWorkspace,
      workspaceRoot: "/workspace/app",
      command: "node",
      args: ["index.js"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/exceeds 2 MiB/u);
    expect(metadataOnlyWorkspace.readBounded).toHaveBeenCalledOnce();
  });

  it("refuses every derived write when any mounted source revision changed during execution", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/app/package.json", '{"name":"before"}');
    const container = fakeContainer({
      exported: {
        "package.json": { file: { contents: '{"name":"before"}' } },
        "package-lock.json": { file: { contents: '{"lockfileVersion":3}' } },
      },
      async spawn() {
        await workspace.write("/workspace/app/package.json", '{"name":"after"}');
        return processResult(0, "installed\n");
      },
    });

    await expect(executeNodeProject(container, {
      runtime: "node-webcontainer",
      workspace,
      workspaceRoot: "/workspace/app",
      command: "npm",
      args: ["install"],
      timeoutMs: 5_000,
      writeBack: true,
      signal: new AbortController().signal,
    })).rejects.toThrow(/older workspace snapshot/u);
    expect(await workspace.read("/workspace/app/package.json")).toMatchObject({ content: '{"name":"after"}' });
    expect(await workspace.read("/workspace/app/package-lock.json")).toBeUndefined();
  });
});

function fakeContainer(options: Readonly<{
  exported: FileSystemTree;
  mount?(tree: FileSystemTree): void;
  export?(): FileSystemTree | Promise<FileSystemTree>;
  spawn?(command: string, args: readonly string[], cwd: string): Promise<WebContainerProcess>;
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
    async spawn(command: string, args: string[], spawnOptions?: { cwd?: string }) {
      if (options.spawn) return options.spawn(command, args, String(spawnOptions?.cwd ?? ""));
      return processResult(options.exitCode ?? 0, "node-ready\n");
    },
    async export() {
      return options.export?.() ?? options.exported;
    },
  } as unknown as Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;
}

function processResult(exitCode: number, output: string): WebContainerProcess {
  return {
    exit: Promise.resolve(exitCode),
    input: new WritableStream<string>(),
    output: new ReadableStream<string>({
      start(controller) {
        controller.enqueue(output);
        controller.close();
      },
    }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}
