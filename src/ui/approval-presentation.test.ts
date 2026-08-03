import { describe, expect, it } from "vitest";
import { remainingApprovalTime, writeApprovalFacts } from "./approval-presentation";
import { BrowserGitClient } from "../git";
import { MemoryGitAdapter } from "../git/memory-adapter";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MemoryWorkspace } from "../workspace/memory";
import { createAirshipToolRegistry } from "../tools/airship-tools";

/**
 * One schema-legal argument object per registered write tool.
 *
 * These are fed to the real registry's validator below, because the panel's
 * whole job is to describe arguments the agent could actually send: a fixture
 * the schema would reject proves nothing about what a person will be shown.
 */
const WRITE_FIXTURES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  write_file: { path: "notes/a.md", content: "newer" },
  replace_text: { path: "notes/a.md", oldText: "old", newText: "newer" },
  move_file: { sourcePath: "notes/a.md", destinationPath: "notes/b.md" },
  remove_file: { path: "/workspace/src/index.ts" },
  text_editor: {
    edits: [
      { path: "one.md", oldText: null, newText: "created" },
      { path: "two.md", oldText: "a", newText: "b" },
      { path: "three.md", oldText: "c", newText: "d" },
    ],
  },
  update_memory: { action: "forget", id: "memory-1" },
  update_tasks: { tasks: [{ id: "one", content: "One", status: "in_progress" }] },
  execute_shell: { script: "echo hi", workspaceRoot: "/workspace/src", writeBack: true },
  execute_workspace_program: {
    code: "await call('a')",
    calls: [{ id: "a", tool: "text_editor", arguments: { edits: [{ path: "x.md", oldText: null, newText: "y" }] } }],
  },
  git_change: { action: "commit", repositoryId: "repo", worktreeId: "tree", expectedWorktreeVersion: "v1", message: "m" },
  git_configure: { action: "add_remote", repositoryId: "repo", expectedRepositoryVersion: "v1", name: "origin", remoteUrl: "https://example.invalid/r.git" },
});

async function writeToolNames(): Promise<readonly string[]> {
  const adapter = await MemoryGitAdapter.create([{ id: "workspace", name: "Workspace", files: {}, workingFiles: {} }]);
  const registry = await createAirshipToolRegistry({
    workspace: new MemoryWorkspace(),
    journal: new EventJournal(new MemoryJournalBackend()),
    git: new BrowserGitClient(adapter),
  });
  const names = registry.definitions().filter((definition) => definition.effect === "write").map((definition) => definition.name);
  for (const [name, fixture] of Object.entries(WRITE_FIXTURES)) {
    // A fixture the tool would reject is not evidence about the panel.
    registry.validateArguments(name, fixture as never);
  }
  return names;
}

describe("approval presentation", () => {
  it("never reports a destructive write as a creation", () => {
    // The measured defect: disposition was inferred from the presence of the
    // optional `expectedRevision` lock, so every one of these read "Create".
    const remove = writeApprovalFacts("remove_file", { path: "/workspace/src/index.ts" });
    expect(remove.disposition).toBe("Delete");
    expect(remove.targets).toEqual(["/workspace/src/index.ts"]);
    expect(remove.disposition).not.toMatch(/create/iu);

    const move = writeApprovalFacts("move_file", { sourcePath: "a.md", destinationPath: "b.md" });
    expect(move.disposition).toMatch(/^Move/u);
    expect(move.targets).toEqual(["a.md → b.md"]);
  });

  it("refuses to promise that an unchecked write creates rather than overwrites", () => {
    const unchecked = writeApprovalFacts("write_file", { path: "a.md", content: "x" });
    expect(unchecked.disposition).toBe("Create or overwrite");
    expect(unchecked.byteLength).toBe(1);
    // A revision lock is the only thing that makes the outcome knowable.
    expect(writeApprovalFacts("write_file", { path: "a.md", content: "x", expectedRevision: "r1" }).disposition)
      .toBe("Replace revision r1");
    expect(writeApprovalFacts("write_file", { path: "large", content: "x".repeat(2_000) }).after)
      .toContain("bounded preview");
  });

  it("states a replacement's byte delta, and withholds it where it is not knowable", () => {
    const one = writeApprovalFacts("replace_text", { path: "a.md", oldText: "old", newText: "newer" });
    expect(one.disposition).toBe("Replace one occurrence in an existing file");
    expect(one.byteDelta).toBe(2);
    expect(one.before).toBe("old");
    expect(one.after).toBe("newer");
    // With `replaceAll` the delta applies once per occurrence and the count is
    // not in the arguments, so no number is printed rather than a wrong one.
    const every = writeApprovalFacts("replace_text", { path: "a.md", oldText: "old", newText: "newer", replaceAll: true });
    expect(every.disposition).toBe("Replace every occurrence in an existing file");
    expect(every.byteDelta).toBeUndefined();
  });

  it("enumerates every path a batched edit declares, and how each one lands", () => {
    const batch = writeApprovalFacts("text_editor", WRITE_FIXTURES.text_editor as never);
    expect(batch.targets).toEqual(["one.md", "two.md", "three.md"]);
    expect(batch.disposition).toBe("3 declared edits: 1 create, 2 replace");
  });

  it("names the scope an execution or Git write is bounded to", () => {
    expect(writeApprovalFacts("execute_shell", { script: "rm -rf x", workspaceRoot: "/workspace/src", writeBack: true }))
      .toMatchObject({ disposition: expect.stringContaining("write its result back"), targets: ["/workspace/src"] });
    expect(writeApprovalFacts("execute_shell", { script: "ls" }).disposition).toContain("no workspace write-back");
    expect(writeApprovalFacts("execute_workspace_program", WRITE_FIXTURES.execute_workspace_program as never).targets)
      .toEqual(["text_editor"]);
    expect(writeApprovalFacts("git_change", WRITE_FIXTURES.git_change as never))
      .toMatchObject({ disposition: expect.stringContaining("Git commit"), targets: ["repo/tree"] });
  });

  it("leads a Git write with the file, not with the two ids that look like one", () => {
    // Rendered before this: "Target airship-workspace, main, README.md" — three
    // peers, of which only the last is what the person is deciding about.
    expect(writeApprovalFacts("git_change", {
      action: "stage", repositoryId: "airship-workspace", worktreeId: "main", paths: ["README.md"], expectedWorktreeVersion: "v1",
    }).targets).toEqual(["README.md", "airship-workspace/main"]);
  });

  it("says so out loud when a write tool has no mapped consequence", async () => {
    // Silence is the failure mode this replaces: an unmapped tool used to
    // render no panel at all, which reads as "this write has no consequence".
    const unmapped = writeApprovalFacts("some_future_write_tool", { anything: true });
    expect(unmapped.derived).toBe(false);
    expect(unmapped.disposition).toContain("read the raw arguments");

    // ...and every tool the production bundle actually registers as a write is
    // mapped, with a disposition that is neither empty nor the marker.
    const names = await writeToolNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const fixture = WRITE_FIXTURES[name];
      expect(fixture, `${name} needs a schema-legal fixture`).toBeDefined();
      const derived = writeApprovalFacts(name, fixture as never);
      expect(derived.derived, `${name} has a mapped consequence`).toBe(true);
      expect(derived.disposition.length, name).toBeGreaterThan(0);
      expect(derived.disposition, name).not.toContain("read the raw arguments");
    }
    // And no fixture describes a tool the bundle no longer registers.
    expect(Object.keys(WRITE_FIXTURES).sort()).toEqual([...names].sort());
  });

  it("formats a fail-closed expiry countdown", () => {
    expect(remainingApprovalTime("2026-07-18T00:02:03.000Z", Date.parse("2026-07-18T00:00:00.000Z"))).toBe("02:03");
    expect(remainingApprovalTime("2026-07-17T00:00:00.000Z", Date.parse("2026-07-18T00:00:00.000Z"))).toBe("00:00");
  });
});
