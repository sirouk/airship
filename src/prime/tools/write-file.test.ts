import { describe, expect, it } from "vitest";
import { WorkspaceConflictError } from "../../workspace/contracts";
import { createPrimeEditFileTool, createPrimeWriteFileTool } from "./write-file";
import { FakeWorkspacePort, makeToolContext } from "./test-utils";

/**
 * write_file/edit_file: create-vs-replace wording, revision-CAS semantics
 * (both the declared expected_revision and the plan-time re-check edit_file
 * applies), the byte cap, and the four named edit refusals (no-match,
 * ambiguous, no-op, binary) plus the integrity refusals.
 */

describe("prime write_file", () => {
  it("creates a new file: Wrote wording, created metadata, no previousRevision", async () => {
    const workspace = new FakeWorkspacePort({});
    const tool = createPrimeWriteFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/new.txt", content: "hello" }, makeToolContext());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Wrote /workspace/new.txt (5 bytes).");
    expect(result.metadata).toEqual({
      path: "/workspace/new.txt",
      revision: "rev-1",
      size: 5,
      created: true,
    });
    expect(workspace.storedContent("/workspace/new.txt")).toBe("hello");
  });

  it("replaces an existing file: Replaced wording with previousRevision", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/a.txt": "old" });
    const tool = createPrimeWriteFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/a.txt", content: "new" }, makeToolContext());
    expect(result.content).toBe("Replaced /workspace/a.txt (3 bytes).");
    expect(result.metadata).toEqual({
      path: "/workspace/a.txt",
      revision: "rev-2",
      size: 3,
      created: false,
      previousRevision: "rev-1",
    });
    expect(workspace.storedContent("/workspace/a.txt")).toBe("new");
  });

  it("honors expected_revision CAS: the read revision succeeds, a stale one throws WorkspaceConflictError", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/cas.txt": "v1 bytes" });
    const tool = createPrimeWriteFileTool(workspace);
    const ok = await tool.execute(
      { path: "/workspace/cas.txt", content: "v2 bytes", expected_revision: "rev-1" },
      makeToolContext(),
    );
    expect(ok.content).toBe("Replaced /workspace/cas.txt (8 bytes).");
    expect(ok.metadata).toMatchObject({ revision: "rev-2", previousRevision: "rev-1" });
    expect(workspace.writes[0]).toEqual({ path: "/workspace/cas.txt", expectedRevision: "rev-1" });

    await expect(
      tool.execute({ path: "/workspace/cas.txt", content: "v3 bytes", expected_revision: "rev-1" }, makeToolContext()),
    ).rejects.toThrow(WorkspaceConflictError);
    expect(workspace.storedContent("/workspace/cas.txt")).toBe("v2 bytes");
  });

  it("expected_revision null is a create-only guard: existing files conflict, absent files write", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/taken.txt": "here" });
    const tool = createPrimeWriteFileTool(workspace);
    await expect(
      tool.execute({ path: "/workspace/taken.txt", content: "mine", expected_revision: null }, makeToolContext()),
    ).rejects.toThrow(WorkspaceConflictError);
    await expect(
      tool.execute({ path: "/workspace/taken.txt", content: "mine", expected_revision: null }, makeToolContext()),
    ).rejects.toThrow(/already exists/);

    const created = await tool.execute(
      { path: "/workspace/fresh.txt", content: "mine", expected_revision: null },
      makeToolContext(),
    );
    expect(created.metadata).toMatchObject({ created: true });
    // The guard is delegated to the port's CAS: both refused attempts reach the seam.
    expect(workspace.writes).toEqual([
      { path: "/workspace/taken.txt", expectedRevision: null },
      { path: "/workspace/taken.txt", expectedRevision: null },
      { path: "/workspace/fresh.txt", expectedRevision: null },
    ]);
  });

  it("refuses content over the byte cap, naming both the payload and the cap", async () => {
    const workspace = new FakeWorkspacePort({});
    const tool = createPrimeWriteFileTool(workspace, { maxWriteBytes: 1_024 });
    await expect(
      tool.execute({ path: "/workspace/big.txt", content: "x".repeat(1_025) }, makeToolContext()),
    ).rejects.toThrow(
      "write_file content is 1025 bytes, over the 1024-byte write budget; split the file across write_file plus edit_file calls.",
    );
  });

  it("refuses control-plane paths on both file tools", async () => {
    const workspace = new FakeWorkspacePort({});
    const writeTool = createPrimeWriteFileTool(workspace);
    const editTool = createPrimeEditFileTool(workspace);
    await expect(
      writeTool.execute({ path: "/workspace/.airship/state.json", content: "x" }, makeToolContext()),
    ).rejects.toThrow("prime file tools exclude Airship control-plane paths: /workspace/.airship/state.json");
    await expect(
      editTool.execute({ path: "repo/.git/config", old_text: "a", new_text: "b" }, makeToolContext()),
    ).rejects.toThrow("prime file tools exclude Airship control-plane paths: /workspace/repo/.git/config");
  });
});

describe("prime edit_file", () => {
  it("edits a unique occurrence and revision-checks the write against the planning read", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/edit.txt": "alpha beta gamma" });
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/edit.txt", old_text: "beta", new_text: "BETA" },
      makeToolContext(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Edited /workspace/edit.txt: replaced 1 occurrence.");
    expect(result.metadata).toEqual({
      path: "/workspace/edit.txt",
      revision: "rev-2",
      previousRevision: "rev-1",
      size: 16,
      replacements: 1,
      replaceAll: false,
    });
    // The CAS token on the write is the revision the edit was planned against.
    expect(workspace.writes[0]).toEqual({ path: "/workspace/edit.txt", expectedRevision: "rev-1" });
    expect(workspace.storedContent("/workspace/edit.txt")).toBe("alpha BETA gamma");
  });

  it("refuses a binary envelope without decoding it", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/bin.dat": "airship-git-binary-v1:QUJD" });
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/bin.dat", old_text: "ABC", new_text: "x" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Refused text edit in binary file: /workspace/bin.dat.");
    expect(result.metadata).toEqual({ path: "/workspace/bin.dat", encoding: "binary" });
  });

  it("refuses old_text with zero occurrences: a wrong premise is not a no-edit", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/edit.txt": "alpha beta gamma" });
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/edit.txt", old_text: "delta", new_text: "epsilon" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("edit_file found no occurrence of old_text in /workspace/edit.txt.");
    expect(result.metadata).toEqual({ path: "/workspace/edit.txt", occurrences: 0 });
  });

  it("refuses an ambiguous edit with the occurrence count and the remedy named", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/edit.txt": "x needle y needle z" });
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/edit.txt", old_text: "needle", new_text: "pin" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Refused ambiguous edit: old_text occurs 2 times in /workspace/edit.txt. " +
        "Widen old_text to a unique passage or set replace_all: true.",
    );
    expect(result.metadata).toEqual({ path: "/workspace/edit.txt", occurrences: 2 });
  });

  it("replace_all swaps every occurrence and reports the count", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/edit.txt": "x needle y needle z needle" });
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/edit.txt", old_text: "needle", new_text: "pin", replace_all: true },
      makeToolContext(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Edited /workspace/edit.txt: replaced 3 occurrences.");
    expect(result.metadata).toMatchObject({ replacements: 3, replaceAll: true, previousRevision: "rev-1", revision: "rev-2" });
    expect(workspace.storedContent("/workspace/edit.txt")).toBe("x pin y pin z pin");
  });

  it("refuses a no-op edit before touching the workspace", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/edit.txt": "alpha beta gamma" });
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/edit.txt", old_text: "beta", new_text: "beta" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Refused a no-op edit in /workspace/edit.txt: old_text and new_text are identical, " +
        "so the file would be byte-identical after the edit.",
    );
    expect(result.metadata).toEqual({ path: "/workspace/edit.txt", noOp: true });
    expect(workspace.writes).toHaveLength(0);
  });

  it("reports a missing file as data, not a throw", async () => {
    const workspace = new FakeWorkspacePort({});
    const tool = createPrimeEditFileTool(workspace);
    const result = await tool.execute(
      { path: "/workspace/missing.txt", old_text: "a", new_text: "b" },
      makeToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: /workspace/missing.txt");
    expect(result.metadata).toEqual({ path: "/workspace/missing.txt" });
  });

  it("expected_revision mismatch is a WorkspaceConflictError naming both revisions", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/edit.txt": "alpha beta gamma" });
    const tool = createPrimeEditFileTool(workspace);
    await expect(
      tool.execute(
        { path: "/workspace/edit.txt", old_text: "beta", new_text: "BETA", expected_revision: "rev-0" },
        makeToolContext(),
      ),
    ).rejects.toThrow(WorkspaceConflictError);
    await expect(
      tool.execute(
        { path: "/workspace/edit.txt", old_text: "beta", new_text: "BETA", expected_revision: "rev-0" },
        makeToolContext(),
      ),
    ).rejects.toThrow(
      "edit_file expected revision rev-0 but /workspace/edit.txt is at rev-1; re-read the file and re-plan the edit.",
    );
  });
});
