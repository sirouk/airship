import { describe, expect, it } from "vitest";
import {
  defaultEditorWrap,
  editorSurfaceNote,
  folderOperationReport,
  settledWorkbenchNotice,
  workbenchDialogCopy,
  WORKBENCH_WRAP_DEFAULT_MAX_WIDTH,
  workspaceNameError,
  WORKBENCH_DESCRIPTION,
  workbenchBufferState,
  workbenchFilterMatches,
  workbenchIdentity,
  workbenchNotice,
  workbenchNoticeState,
  workbenchRailPercent,
  workbenchSuggestedFiles,
  workbenchTabQualifiers,
  WORKBENCH_RAIL_DEFAULT_PERCENT,
  WORKBENCH_RAIL_MAX_PERCENT,
  WORKBENCH_RAIL_MIN_PERCENT,
} from "./workbench-model";

describe("workbench route identity", () => {
  it("gives each destination its own name instead of one wrong name for both", () => {
    expect(workbenchIdentity("#workspace").title).toBe("Workspace");
    expect(workbenchIdentity("#editor").title).toBe("Editor");
    expect(workbenchIdentity("workspace").title).toBe("Workspace");
  });

  it("lands #editor in the editor pane and #workspace in the tree", () => {
    expect(workbenchIdentity("#editor").opensPane).toBe("editor");
    expect(workbenchIdentity("#workspace").opensPane).toBe("navigation");
  });

  it("resolves an unknown hash to Workspace rather than inventing a third name", () => {
    expect(workbenchIdentity("#chat")).toMatchObject({ route: "workspace", title: "Workspace" });
    expect(workbenchIdentity("")).toMatchObject({ route: "workspace" });
  });

  it("keeps the route sentence verbatim so the ⓘ carries the original words", () => {
    expect(workbenchIdentity("#editor").description).toBe(WORKBENCH_DESCRIPTION);
    expect(WORKBENCH_DESCRIPTION).toContain("browser-native source control share one workspace");
  });
});

describe("duplicate tab basenames", () => {
  it("qualifies only the names that repeat", () => {
    const qualifiers = workbenchTabQualifiers([
      "/workspace/src/runtime/index.ts",
      "/workspace/src/ui/index.ts",
      "/workspace/README.md",
    ]);
    expect(qualifiers["/workspace/src/runtime/index.ts"]).toBe("runtime");
    expect(qualifiers["/workspace/src/ui/index.ts"]).toBe("ui");
    expect(qualifiers["/workspace/README.md"]).toBe("");
  });
});

describe("rail width", () => {
  it("never lets the file list starve the code column", () => {
    expect(workbenchRailPercent(4)).toBe(WORKBENCH_RAIL_MIN_PERCENT);
    expect(workbenchRailPercent(90)).toBe(WORKBENCH_RAIL_MAX_PERCENT);
    expect(workbenchRailPercent(30.44)).toBe(30.4);
  });

  it("falls back to the default rather than emitting NaN into the layout", () => {
    expect(workbenchRailPercent(Number.NaN)).toBe(WORKBENCH_RAIL_DEFAULT_PERCENT);
  });
});

describe("notice lifetime", () => {
  it("drops a progress verb the moment the work stops", () => {
    expect(settledWorkbenchNotice(workbenchNotice("progress", "Creating file…"))).toBeUndefined();
  });

  it("keeps an outcome the caller chose to state", () => {
    const done = workbenchNotice("done", "Saved README.md with revision compare-and-swap.");
    expect(settledWorkbenchNotice(done)).toBe(done);
    const failure = workbenchNotice("error", "The selected file no longer exists.");
    expect(settledWorkbenchNotice(failure)).toBe(failure);
    expect(settledWorkbenchNotice(undefined)).toBeUndefined();
  });

  it("maps each tone onto the one status vocabulary", () => {
    expect(workbenchNoticeState("progress")).toBe("checking");
    expect(workbenchNoticeState("done")).toBe("verified");
    expect(workbenchNoticeState("error")).toBe("failed");
  });
});

describe("file strip verdict", () => {
  it("keeps the shipped words for the editable cases", () => {
    expect(workbenchBufferState({ binary: false, truncated: false, dirty: false }).word).toBe("Saved");
    expect(workbenchBufferState({ binary: false, truncated: false, dirty: true }).word).toBe("Modified");
  });

  it("never claims verification for a page-memory write", () => {
    for (const dirty of [true, false]) {
      expect(workbenchBufferState({ binary: false, truncated: false, dirty }).state).not.toBe("verified");
    }
  });

  it("gives the read-only cases their own vocabulary", () => {
    expect(workbenchBufferState({ binary: true, truncated: true, dirty: false })).toMatchObject({
      word: "Protected bytes",
      detail: "Binary · read-only",
    });
    expect(workbenchBufferState({ binary: false, truncated: true, dirty: false }).word).toBe("Bounded preview");
  });

  it("states every verdict in a sentence, never in a colour alone", () => {
    for (const binary of [true, false]) {
      for (const truncated of [true, false]) {
        for (const dirty of [true, false]) {
          const verdict = workbenchBufferState({ binary, truncated, dirty });
          expect(verdict.word.length).toBeGreaterThan(0);
          expect(verdict.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("empty-pane suggestions", () => {
  it("offers the largest files first, deterministically", () => {
    const files = [
      { path: "/workspace/a.md", size: 10 },
      { path: "/workspace/b.md", size: 900 },
      { path: "/workspace/c.md", size: 900 },
      { path: "/workspace/d.md", size: 40 },
    ];
    expect(workbenchSuggestedFiles(files).map((entry) => entry.path))
      .toEqual(["/workspace/b.md", "/workspace/c.md", "/workspace/d.md"]);
  });

  it("does not mutate the caller's list", () => {
    const files = [{ path: "/workspace/a.md", size: 1 }, { path: "/workspace/b.md", size: 2 }];
    workbenchSuggestedFiles(files);
    expect(files[0]!.path).toBe("/workspace/a.md");
  });
});

describe("tree filter", () => {
  it("counts what is shown against what exists", () => {
    const files = [
      { path: "/workspace/docs/architecture.md" },
      { path: "/workspace/notes/retrieval.md" },
      { path: "/workspace/README.md" },
    ];
    expect(workbenchFilterMatches(files, "arch")).toMatchObject({ shown: 1, total: 3 });
    expect(workbenchFilterMatches(files, "  ")).toMatchObject({ shown: 3, total: 3 });
    expect(workbenchFilterMatches(files, "MD").shown).toBe(3);
    expect(workbenchFilterMatches(files, "nothing-here").shown).toBe(0);
  });
});

describe("workbench dialog copy", () => {
  it("never lets a title fall back to the enum", () => {
    // The shipped `aria-label` was `${dialog.kind} workspace file`, so a screen
    // reader heard "discard workspace file" and never the file. The heading is
    // now the accessible name, so there is exactly one name to keep honest.
    for (const kind of ["create", "create-folder", "rename", "rename-folder", "move", "delete", "delete-folder", "discard"] as const) {
      const copy = workbenchDialogCopy(kind, "/workspace/notes/plan.md", 3);
      expect(copy.title).not.toContain(kind);
      expect(copy.title).not.toMatch(/workspace file$/u);
      expect(copy.confirm.length).toBeGreaterThan(0);
    }
  });

  it("puts the file name in the title of every dialog that has one", () => {
    expect(workbenchDialogCopy("move", "/workspace/a/b/really-long-name.tsx").title).toBe("Move really-long-name.tsx");
    expect(workbenchDialogCopy("rename", "/workspace/a/b/plan.md").title).toBe("Rename plan.md");
    expect(workbenchDialogCopy("delete", "/workspace/a/b/plan.md").title).toBe("Delete plan.md");
  });

  it("states the size of a folder operation in its own button", () => {
    expect(workbenchDialogCopy("delete-folder", "/workspace/notes", 14).confirm).toBe("Delete 14 files");
    expect(workbenchDialogCopy("delete-folder", "/workspace/notes", 1).confirm).toBe("Delete 1 file");
    expect(workbenchDialogCopy("rename-folder", "/workspace/notes", 14).confirm).toBe("Rename 14 files");
  });

  it("marks exactly the kinds that destroy something", () => {
    const destructive = (["create", "create-folder", "rename", "rename-folder", "move", "delete", "delete-folder", "discard"] as const)
      .filter((kind) => workbenchDialogCopy(kind, "/workspace/x").destructive);
    expect(destructive).toEqual(["delete", "delete-folder", "discard"]);
  });
});

describe("workspace name validation", () => {
  it("says why, rather than only disabling the button", () => {
    expect(workspaceNameError("notes")).toBeUndefined();
    expect(workspaceNameError("  ")).toBe("Enter a name.");
    expect(workspaceNameError("a/b")).toContain("one segment");
    expect(workspaceNameError("..")).toContain("not names this workspace can address");
  });
});

describe("folder operation reporting", () => {
  it("reports a partial outcome as partial instead of as a clean failure", () => {
    const report = folderOperationReport({ verb: "Renamed", done: 9, total: 14, target: "journal", failure: "Revision conflict." });
    expect(report).toContain("Renamed 9 of 14 files");
    expect(report).toContain("Revision conflict.");
    expect(report).toContain("The remaining files were not touched.");
  });

  it("counts the whole set when nothing failed", () => {
    expect(folderOperationReport({ verb: "Deleted", done: 3, total: 3, target: "notes" })).toBe("Deleted 3 files in notes.");
    expect(folderOperationReport({ verb: "Deleted", done: 1, total: 1, target: "notes" })).toBe("Deleted 1 file in notes.");
  });
});

describe("editor wrap", () => {
  it("defaults on at phone widths and off where a line of code fits", () => {
    expect(defaultEditorWrap(390)).toBe(true);
    expect(defaultEditorWrap(WORKBENCH_WRAP_DEFAULT_MAX_WIDTH)).toBe(true);
    expect(defaultEditorWrap(WORKBENCH_WRAP_DEFAULT_MAX_WIDTH + 1)).toBe(false);
    expect(defaultEditorWrap(1440)).toBe(false);
    expect(defaultEditorWrap(undefined)).toBe(false);
  });

  it("states that wrapping retires the gutter, instead of numbers vanishing", () => {
    expect(editorSurfaceNote({ wrap: true, binary: false })).toBe("UTF-8 · LF · client-side · wrapped, no line numbers");
    expect(editorSurfaceNote({ wrap: false, binary: false })).toBe("UTF-8 · LF · client-side");
    // A binary buffer has no editable surface to describe either way.
    expect(editorSurfaceNote({ wrap: true, binary: true })).toBe("Binary · read-only · client-side");
  });
});
