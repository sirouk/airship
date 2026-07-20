import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "./memory";
import { moveWorkspaceFile } from "./mutations";

describe("workspace file moves", () => {
  it("moves bytes without overwriting a target", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("src/a.ts", "export const a = 1;", { expectedRevision: null });
    const moved = await moveWorkspaceFile(workspace, "src/a.ts", "lib/a.ts");
    expect(moved.path).toBe("/workspace/lib/a.ts");
    expect(await workspace.read("src/a.ts")).toBeUndefined();
    expect((await workspace.read("lib/a.ts"))?.content).toBe("export const a = 1;");
    await workspace.write("src/b.ts", "source", { expectedRevision: null });
    await workspace.write("lib/b.ts", "target", { expectedRevision: null });
    await expect(moveWorkspaceFile(workspace, "src/b.ts", "lib/b.ts")).rejects.toThrow("already exists");
    expect((await workspace.read("src/b.ts"))?.content).toBe("source");
    expect((await workspace.read("lib/b.ts"))?.content).toBe("target");
  });
});
