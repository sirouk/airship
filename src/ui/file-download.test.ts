import { describe, expect, it } from "vitest";
import { downloadFileName } from "./file-download";

describe("download filenames", () => {
  it("keeps the basename and nothing that could act as a path", () => {
    expect(downloadFileName("/workspace/docs/architecture.md")).toBe("architecture.md");
    expect(downloadFileName("/workspace/.gitkeep")).toBe(".gitkeep");
    // `anchor.download` is a filename, not a path: a separator in it is either
    // ignored or rewritten by the browser, so it never reaches the platform.
    expect(downloadFileName("/workspace/notes/2026/plan.md")).toBe("plan.md");
    expect(downloadFileName("a\\b\\report.csv")).toBe("report.csv");
  });

  it("strips control characters rather than passing them to the platform", () => {
    const hostile = `/workspace/re${String.fromCodePoint(13)}port${String.fromCodePoint(10)}.txt`;
    expect(downloadFileName(hostile)).toBe("report.txt");
    expect(downloadFileName(`/workspace/${String.fromCodePoint(127)}notes.md`)).toBe("notes.md");
  });

  it("falls back rather than emitting an empty or relative name", () => {
    expect(downloadFileName("/workspace/")).toBe("workspace");
    expect(downloadFileName("")).toBe("workspace-file");
    expect(downloadFileName("/")).toBe("workspace-file");
    expect(downloadFileName(`/workspace/${String.fromCodePoint(9)}`)).toBe("workspace-file");
  });
});
