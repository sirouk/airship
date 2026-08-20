import { describe, expect, it } from "vitest";
import { createPrimeReadFileTool } from "./read-file";
import { FakeWorkspacePort, makeToolContext } from "./test-utils.test-support";

/**
 * read_file: the line-oriented read head policy over WorkspacePort
 * (2,000 lines / 50 KiB, never mid-line), the notice-first continuation
 * envelope, the integrity refusals (control-plane, binary envelope), and
 * the bounded storage scan that drops half-lines.
 */

function linesFile(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`).join("\n");
}

describe("prime read_file", () => {
  it("reads a small file fully: raw content, no notice, revision in metadata", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/notes.txt": "first\nsecond\nthird" });
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "notes.txt" }, makeToolContext());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("first\nsecond\nthird");
    expect(result.metadata).toEqual({
      path: "/workspace/notes.txt",
      revision: "rev-1",
      offset: 1,
      returnedLines: 3,
      returnedBytes: 18,
      totalBytes: 18,
      totalLines: 3,
      scanComplete: true,
      truncated: false,
      truncatedBy: null,
    });
    expect(result.metadata).not.toHaveProperty("nextOffsetLine");
  });

  it("paginates with offset/limit: notice-first content whose nextOffsetLine resumes the window", async () => {
    const text = linesFile(10);
    const workspace = new FakeWorkspacePort({ "/workspace/book.txt": text });
    const tool = createPrimeReadFileTool(workspace);

    const first = await tool.execute({ path: "/workspace/book.txt", offset: 1, limit: 3 }, makeToolContext());
    const expectedNotice =
      "[prime read_file returned lines 1\u20133 of 10 for /workspace/book.txt (23 of 79 bytes, bounded by limit). " +
      'Continue with read_file {"path":"/workspace/book.txt","offset":4}.]';
    expect(first.content.startsWith(`${expectedNotice}\n\n`)).toBe(true);
    expect(first.content.endsWith("line-01\nline-02\nline-03")).toBe(true);
    expect(first.metadata).toMatchObject({
      path: "/workspace/book.txt",
      revision: "rev-1",
      offset: 1,
      returnedLines: 3,
      returnedBytes: 23,
      totalBytes: 79,
      totalLines: 10,
      truncated: true,
      truncatedBy: "limit",
      nextOffsetLine: 4,
    });

    const middle = await tool.execute({ path: "/workspace/book.txt", offset: 4, limit: 5 }, makeToolContext());
    expect(middle.metadata).toMatchObject({ offset: 4, returnedLines: 5, nextOffsetLine: 9, truncatedBy: "limit" });
    expect(middle.content).toContain("returned lines 4\u20138 of 10");
    expect(middle.content).toContain("\"offset\":9");

    const last = await tool.execute({ path: "/workspace/book.txt", offset: 9, limit: 10 }, makeToolContext());
    expect(last.content).toBe("line-09\nline-10");
    expect(last.metadata).toMatchObject({ truncated: false, truncatedBy: null, returnedLines: 2 });
    expect(last.metadata).not.toHaveProperty("nextOffsetLine");
  });

  it("truncates at the 2,000-line head bound and names lines as the bound", async () => {
    const text = Array.from({ length: 2_001 }, (_, index) => `row-${String(index + 1).padStart(4, "0")}`).join("\n");
    const workspace = new FakeWorkspacePort({ "/workspace/wide.txt": text });
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/wide.txt" }, makeToolContext());
    expect(result.metadata).toMatchObject({
      returnedLines: 2_000,
      returnedBytes: 17_999,
      totalBytes: 18_008,
      totalLines: 2_001,
      truncated: true,
      truncatedBy: "lines",
      nextOffsetLine: 2_001,
    });
    expect(result.content).toContain("bounded by lines");
    // Never mid-line: the window's last byte is the 2,000th complete line.
    expect(result.content.endsWith("row-2000")).toBe(true);
  });

  it("truncates at the 50 KiB byte bound without ever splitting a line", async () => {
    const lines = Array.from({ length: 600 }, (_, index) => `L${String(index).padStart(4, "0")}:${"#".repeat(94)}`);
    const workspace = new FakeWorkspacePort({ "/workspace/dense.txt": lines.join("\n") });
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/dense.txt" }, makeToolContext());
    // 507 lines fit in 51,206 bytes; the 508th line crosses 51,200, is kept WHOLE
    // (one complete line of overrun, never a partial line), and the walk stops.
    expect(result.metadata).toMatchObject({
      returnedLines: 508,
      returnedBytes: 51_307,
      totalBytes: 60_599,
      totalLines: 600,
      truncated: true,
      truncatedBy: "bytes",
      nextOffsetLine: 509,
    });
    expect(result.content).toContain("bounded by bytes");
    expect(result.content).toContain("\"offset\":509");
    // Never mid-line: the last returned line is the complete 100-char 508th line.
    const keptTail = result.content.slice(result.content.lastIndexOf("\n") + 1);
    expect(keptTail).toBe(`L0507:${"#".repeat(94)}`);
  });

  it("names a first line that alone exceeds the byte budget, with its own size", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/mono.txt": "m".repeat(60_000) });
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/mono.txt" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Line 1 of /workspace/mono.txt is 60000 bytes, exceeding the 51200-byte read budget. " +
        "Use search_text to locate content inside it, or execute_code for byte-level access.",
    );
    expect(result.metadata).toEqual({
      path: "/workspace/mono.txt",
      revision: "rev-1",
      offset: 1,
      lineBytes: 60_000,
      maxBytes: 51_200,
    });
  });

  it("drops the half-line a bounded scan cut through, and names scan as the bound", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/scan.txt": "alpha\nbeta\ngamma-delta" });
    const tool = createPrimeReadFileTool(workspace, { maxLines: 2_000, maxBytes: 51_200, readScanBytes: 9 });
    const result = await tool.execute({ path: "/workspace/scan.txt" }, makeToolContext());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("bounded by scan");
    expect(result.content).toContain('"offset":2');
    expect(result.content.endsWith("alpha")).toBe(true);
    expect(result.content).not.toContain("beta");
    expect(result.metadata).toMatchObject({
      returnedLines: 1,
      returnedBytes: 5,
      totalBytes: 22,
      scannedLines: 1,
      scanComplete: false,
      truncated: true,
      truncatedBy: "scan",
      nextOffsetLine: 2,
    });
    expect(result.metadata).not.toHaveProperty("totalLines");
  });

  it("answers beyond-end with the bounded-scan shape when the scan holds no complete line", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/mb.txt": "h\u00e9llo world" });
    const tool = createPrimeReadFileTool(workspace, { maxLines: 2_000, maxBytes: 51_200, readScanBytes: 3 });
    const result = await tool.execute({ path: "/workspace/mb.txt" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "read_file offset 1 is beyond the end of /workspace/mb.txt, of which the bounded scan (3 of 12 bytes) holds 0 complete lines.",
    );
    expect(result.metadata).toMatchObject({ scannedLines: 0, totalBytes: 12, scanComplete: false, revision: "rev-1" });
  });

  it("refuses control-plane paths before touching storage", async () => {
    const workspace = new FakeWorkspacePort({});
    const tool = createPrimeReadFileTool(workspace);
    await expect(tool.execute({ path: "/workspace/.airship/state.json" }, makeToolContext())).rejects.toThrow(
      "prime read_file excludes Airship control-plane paths: /workspace/.airship/state.json",
    );
    await expect(tool.execute({ path: "repo/.git/config" }, makeToolContext())).rejects.toThrow(
      "prime read_file excludes Airship control-plane paths: /workspace/repo/.git/config",
    );
  });

  it("refuses a binary envelope with the byte-level alternative named", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/bin.dat": "airship-git-binary-v1:QUJD" });
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/bin.dat" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Binary file is not available through read_file: /workspace/bin.dat. Use execute_code for byte-level access.",
    );
    expect(result.metadata).toEqual({ path: "/workspace/bin.dat", revision: "rev-1", encoding: "binary", size: 26 });
  });

  it("reports a missing file as data, not a throw", async () => {
    const workspace = new FakeWorkspacePort({});
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/missing.txt" }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: /workspace/missing.txt");
    expect(result.metadata).toEqual({ path: "/workspace/missing.txt" });
  });

  it("refuses an offset beyond the last line, naming the known line count", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/short.txt": "one\ntwo\nthree" });
    const tool = createPrimeReadFileTool(workspace);
    const result = await tool.execute({ path: "/workspace/short.txt", offset: 9 }, makeToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("read_file offset 9 is beyond the end of /workspace/short.txt, which has 3 lines.");
    expect(result.metadata).toMatchObject({ scannedLines: 3, scanComplete: true, revision: "rev-1" });
  });

  it("validates offset/limit as 1-indexed integers before reading", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/a.txt": "a" });
    const tool = createPrimeReadFileTool(workspace);
    await expect(tool.execute({ path: "/workspace/a.txt", offset: 1.5 }, makeToolContext())).rejects.toThrow(
      "offset must be an integer.",
    );
    await expect(tool.execute({ path: "/workspace/a.txt", offset: 0 }, makeToolContext())).rejects.toThrow(
      "offset is 1-indexed and must be at least 1.",
    );
    await expect(tool.execute({ path: "/workspace/a.txt", limit: 0 }, makeToolContext())).rejects.toThrow(
      "limit must be at least 1.",
    );
  });
});
