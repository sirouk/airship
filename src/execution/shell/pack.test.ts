import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes } from "../../workspace/content-codec";
import { MemoryWorkspace } from "../../workspace/memory";
import type { ExecutionRequest } from "../runtime-registry";
import { AIRSHIP_SH_ENGINE } from "./contract";
import { executeAirshipShellRequest } from "./pack";

function request(overrides: Partial<ExecutionRequest> & Pick<ExecutionRequest, "code">): ExecutionRequest {
  return {
    runtime: "airship-sh",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("airship-sh workspace transaction", () => {
  it("mounts a selected subtree and reports its provenance", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/a.txt", "alpha\n");
    await workspace.write("/workspace/other/b.txt", "beta\n");

    const result = await executeAirshipShellRequest(
      request({ code: "ls; cat a.txt", workspace, workspaceRoot: "/workspace/project" }),
    );

    expect(result).toMatchObject({ runtime: "airship-sh", exitCode: 0, stdout: "a.txt\nalpha\n" });
    expect(result.provenance).toEqual({
      capabilityTier: "web-baseline",
      authority: "browser",
      engine: AIRSHIP_SH_ENGINE,
      artifactKind: "shell-script",
    });
    expect(result.workspace).toMatchObject({ root: "/workspace/project", mountedFiles: 1, adopted: false });
  });

  it("reports changes without adopting them when writeBack is absent", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/a.txt", "alpha\n");

    const result = await executeAirshipShellRequest(
      request({ code: "echo changed > a.txt; echo new > b.txt", workspace, workspaceRoot: "/workspace/project" }),
    );

    expect(result.workspace?.changedPaths).toEqual(["/workspace/project/a.txt", "/workspace/project/b.txt"]);
    expect(result.workspace?.writtenPaths).toEqual([]);
    expect(result.workspace?.adopted).toBe(false);
    expect((await workspace.read("/workspace/project/a.txt"))?.content).toBe("alpha\n");
  });

  it("adopts changes with revision CAS when writeBack succeeds", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/a.txt", "alpha\n");

    const result = await executeAirshipShellRequest(
      request({
        code: "sed 's/alpha/omega/' a.txt > tmp && mv tmp a.txt; echo made > b.txt",
        workspace,
        workspaceRoot: "/workspace/project",
        writeBack: true,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.workspace?.adopted).toBe(true);
    expect((await workspace.read("/workspace/project/a.txt"))?.content).toBe("omega\n");
    expect((await workspace.read("/workspace/project/b.txt"))?.content).toBe("made\n");
  });

  it("adopts nothing when the script exits nonzero", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/a.txt", "alpha\n");

    const result = await executeAirshipShellRequest(
      request({ code: "echo changed > a.txt; exit 3", workspace, workspaceRoot: "/workspace/project", writeBack: true }),
    );

    expect(result.exitCode).toBe(3);
    expect(result.workspace?.writtenPaths).toEqual([]);
    expect((await workspace.read("/workspace/project/a.txt"))?.content).toBe("alpha\n");
  });

  it("adopts a deletion the script performed", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/gone.txt", "x\n");

    const result = await executeAirshipShellRequest(
      request({ code: "rm gone.txt", workspace, workspaceRoot: "/workspace/project", writeBack: true }),
    );

    expect(result.workspace?.deletedPaths).toEqual(["/workspace/project/gone.txt"]);
    expect(await workspace.read("/workspace/project/gone.txt")).toBeUndefined();
  });

  it("fails closed when the workspace changed under a writeback", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/a.txt", "alpha\n");
    // The mount reads honestly; a competing writer lands afterwards, so the
    // conflict must be caught by the writeback preflight, not by the snapshot.
    let reads = 0;
    const racing = new Proxy(workspace, {
      get(target, property, receiver) {
        if (property !== "read") return Reflect.get(target, property, receiver);
        return async (path: string) => {
          const file = await target.read(path);
          reads += 1;
          return file && reads > 1 ? { ...file, revision: "someone-else-wrote" } : file;
        };
      },
    });

    await expect(
      executeAirshipShellRequest(
        request({ code: "echo changed > a.txt", workspace: racing, workspaceRoot: "/workspace/project", writeBack: true }),
      ),
    ).rejects.toThrow(/conflicted/u);
  });

  it("never mounts control-plane paths", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/.git/config", "secret\n");
    await workspace.write("/workspace/project/node_modules/pkg/index.js", "x\n");
    await workspace.write("/workspace/project/keep.txt", "y\n");

    const result = await executeAirshipShellRequest(
      request({ code: "ls -a", workspace, workspaceRoot: "/workspace/project" }),
    );

    expect(result.stdout).toBe("keep.txt\n");
    expect(result.workspace?.mountedFiles).toBe(1);
  });

  it("refuses a write into an excluded segment inside the shell itself", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/keep.txt", "y\n");

    const result = await executeAirshipShellRequest(
      request({ code: "mkdir -p .git && echo pwned > .git/config", workspace, workspaceRoot: "/workspace/project", writeBack: true }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/excludes the \.git path segment/u);
    expect(await workspace.read("/workspace/project/.git/config")).toBeUndefined();
  });

  it("keeps the scratch tree out of the workspace entirely", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/keep.txt", "y\n");

    const result = await executeAirshipShellRequest(
      request({ code: "echo scratch > /tmp/work; cat /tmp/work", workspace, workspaceRoot: "/workspace/project", writeBack: true }),
    );

    expect(result.stdout).toBe("scratch\n");
    expect(result.workspace?.changedPaths).toEqual([]);
    expect(await workspace.read("/workspace/tmp/work")).toBeUndefined();
  });

  it("names an empty directory it could not store rather than dropping it silently", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/keep.txt", "y\n");

    const result = await executeAirshipShellRequest(
      request({ code: "mkdir -p empty/dir", workspace, workspaceRoot: "/workspace/project", writeBack: true }),
    );

    expect(result.workspace?.refusalReason).toMatch(/empty directory path/u);
  });

  it("runs without any workspace binding at all", async () => {
    const result = await executeAirshipShellRequest(request({ code: "echo unbound" }));
    expect(result).toMatchObject({ exitCode: 0, stdout: "unbound\n" });
    expect(result.workspace).toBeUndefined();
  });

  it("rejects a request that is not a shell script", async () => {
    await expect(executeAirshipShellRequest(request({ code: "echo x", wasmBase64: "AGFzbQEAAAA=" }))).rejects.toThrow(
      /not a WASI artifact/u,
    );
    await expect(
      executeAirshipShellRequest({ ...request({ code: "echo x" }), writeBack: true }),
    ).rejects.toThrow(/writeback requires a workspaceRoot/u);
  });

  it("mounts binary workspace bytes without decoding them as text", async () => {
    const workspace = new MemoryWorkspace();
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80]);
    await workspace.write("/workspace/project/blob.bin", encodeWorkspaceBytes(bytes));

    const result = await executeAirshipShellRequest(
      request({ code: "cp blob.bin copy.bin", workspace, workspaceRoot: "/workspace/project", writeBack: true }),
    );

    expect(result.exitCode).toBe(0);
    expect((await workspace.read("/workspace/project/copy.bin"))?.content).toBe(encodeWorkspaceBytes(bytes));
  });

  it("passes args and env into the script", async () => {
    const result = await executeAirshipShellRequest(
      request({ code: `echo "$1-$2-$MODE"`, args: ["a", "b"], env: { MODE: "fast" } }),
    );
    expect(result.stdout).toBe("a-b-fast\n");
  });
});
