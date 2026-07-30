import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextEditorSelection, type EditorSelection } from "./editor-selection";
import type { WorkspaceFile } from "../workspace/contracts";

function file(path: string): WorkspaceFile {
  return { path, content: `contents of ${path}`, revision: "sha256:r", updatedAt: "2026-01-01T00:00:00.000Z", size: 8 };
}

function selection(path: string, profileId = "profile-a"): EditorSelection {
  return Object.freeze({ profileId, file: file(path) });
}

describe("nextEditorSelection", () => {
  it("holds the file that opened", () => {
    const opened = nextEditorSelection(selection("notes/old.md"), {
      path: "notes/new.md",
      ownerProfileId: "profile-a",
      file: file("notes/new.md"),
    });
    expect(opened?.file.path).toBe("notes/new.md");
    expect(opened?.profileId).toBe("profile-a");
    expect(Object.isFrozen(opened)).toBe(true);
  });

  /*
   * The defect this closes. `openFile` blanked the selection for any path it
   * could not resolve, so a click on a Memory source whose file had been
   * deleted closed the unrelated document the person was reading — and
   * `openMemorySource` then told them "No document was opened", which was the
   * one thing that had not happened.
   */
  it("does not close a document it did not open", () => {
    const current = selection("notes/reading.md");
    expect(nextEditorSelection(current, {
      path: "notes/deleted.md",
      ownerProfileId: "profile-a",
      file: undefined,
    })).toBe(current);
  });

  it("drops the open document when the open document is the path that vanished", () => {
    // Not symmetry-breaking for its own sake: the file behind this document is
    // gone, so keeping it up would present deleted content as live and let a
    // save recreate the file the workspace no longer has.
    expect(nextEditorSelection(selection("notes/reading.md"), {
      path: "notes/reading.md",
      ownerProfileId: "profile-a",
      file: undefined,
    })).toBeUndefined();
  });

  it("leaves another profile's document alone even when the paths match", () => {
    const other = selection("notes/reading.md", "profile-b");
    expect(nextEditorSelection(other, {
      path: "notes/reading.md",
      ownerProfileId: "profile-a",
      file: undefined,
    })).toBe(other);
  });

  it("stays undefined when nothing was open and nothing resolved", () => {
    expect(nextEditorSelection(undefined, {
      path: "notes/deleted.md",
      ownerProfileId: "profile-a",
      file: undefined,
    })).toBeUndefined();
  });
});

describe("openFile", () => {
  it("decides the selection through the rule, against the latest state", () => {
    const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    const body = source.match(/async function openFile\([\s\S]*?\n  \}\n/u)?.[0] ?? "";
    expect(body).toContain("nextEditorSelection(current,");
    // The updater form, not the captured render value: the workspace read is
    // awaited, so a selection set while it was in flight is the one the rule
    // has to be applied to.
    expect(body).toContain("setSelectedFileSelection((current) =>");
    expect(body).not.toContain("setSelectedFileSelection(file ?");
  });
});
