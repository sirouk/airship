import { describe, expect, it } from "vitest";
import { createPrimeListFilesTool, createPrimeSearchTextTool } from "./search-tools";
import { FakeWorkspacePort, makeToolContext } from "./test-utils";

/**
 * list_files/search_text: deterministic inventory (sorted, control-plane
 * and node_modules excluded), literal matching with row/column positions
 * sorted by (path, line, column), every budget named (total-byte cap with
 * nextCursor, result cap with capReachedIn, per-file byte cap), and the
 * include-glob filter including its 0-selected refusal.
 */

interface ListFilesContent {
  summary: {
    path: string;
    returned: number;
    totalVisible: number;
    complete: boolean;
    nextCursor?: string;
  };
  entries: { path: string; size: number; updatedAt: string }[];
}

interface SearchContent {
  summary: string;
  complete: boolean;
  nextCursor?: string;
  capReachedIn?: string;
  matches: { path: string; line: number; column: number; snippet: string }[];
}

function parseList(content: string): ListFilesContent {
  return JSON.parse(content) as ListFilesContent;
}

function parseSearch(content: string): SearchContent {
  return JSON.parse(content) as SearchContent;
}

/** Pad to exactly `bytes` UTF-8 bytes using single-byte filler. */
function padTo(head: string, bytes: number): string {
  const headBytes = new TextEncoder().encode(head).byteLength;
  if (headBytes > bytes) throw new Error("head exceeds the byte target");
  return head + "#".repeat(bytes - headBytes);
}

describe("prime list_files", () => {
  it("lists model-visible files sorted by path, excluding .airship/.git/node_modules", async () => {
    const workspace = new FakeWorkspacePort({
      "/workspace/node_modules/pkg/index.js": "module.exports = {};",
      "/workspace/.airship/context/state.json": "{}",
      "/workspace/repo/.git/config": "[core]",
      "/workspace/b.txt": "bbb",
      "/workspace/a.ts": "aaa",
      "/workspace/src/child/c.ts": "ccc",
    });
    const tool = createPrimeListFilesTool(workspace);
    const result = await tool.execute({}, makeToolContext());
    expect(result.isError).toBeUndefined();
    const body = parseList(result.content);
    expect(body.summary).toEqual({ path: "/workspace", returned: 3, totalVisible: 3, complete: true });
    expect(body.summary).not.toHaveProperty("nextCursor");
    expect(body.entries.map((entry) => entry.path)).toEqual([
      "/workspace/a.ts",
      "/workspace/b.txt",
      "/workspace/src/child/c.ts",
    ]);
    expect(body.entries[0]).toMatchObject({ path: "/workspace/a.ts", size: 3 });
    expect(typeof body.entries[0]?.updatedAt).toBe("string");
    expect(result.metadata).toMatchObject({ path: "/workspace", returned: 3, totalVisible: 3, complete: true });
  });

  it("paginates in sorted order with nextCursor resuming after the last listed path", async () => {
    const workspace = new FakeWorkspacePort({
      "/workspace/a.ts": "a",
      "/workspace/b.txt": "b",
      "/workspace/src/c.ts": "c",
    });
    const tool = createPrimeListFilesTool(workspace);
    const first = parseList((await tool.execute({ limit: 2 }, makeToolContext())).content);
    expect(first.summary).toMatchObject({ returned: 2, totalVisible: 3, complete: false, nextCursor: "/workspace/b.txt" });
    expect(first.entries.map((entry) => entry.path)).toEqual(["/workspace/a.ts", "/workspace/b.txt"]);

    const resumed = parseList((await tool.execute({ limit: 2, cursor: first.summary.nextCursor as string }, makeToolContext())).content);
    expect(resumed.summary).toMatchObject({ returned: 1, totalVisible: 3, complete: true });
    expect(resumed.summary).not.toHaveProperty("nextCursor");
    expect(resumed.entries.map((entry) => entry.path)).toEqual(["/workspace/src/c.ts"]);
  });
});

describe("prime search_text", () => {
  it("finds literal matches with row/column and sorts by (path, line, column)", async () => {
    const workspace = new FakeWorkspacePort({
      "/workspace/b.ts": "beta\nneedle here\nneedle and needle",
      "/workspace/a.ts": "needle first\nplain",
    });
    const tool = createPrimeSearchTextTool(workspace);
    const result = await tool.execute({ query: "needle" }, makeToolContext());
    expect(result.isError).toBeUndefined();
    const body = parseSearch(result.content);
    expect(body.complete).toBe(true);
    expect(body.matches).toEqual([
      { path: "/workspace/a.ts", line: 1, column: 1, snippet: "needle first" },
      { path: "/workspace/b.ts", line: 2, column: 1, snippet: "needle here" },
      { path: "/workspace/b.ts", line: 3, column: 1, snippet: "needle and needle" },
      { path: "/workspace/b.ts", line: 3, column: 12, snippet: "needle and needle" },
    ]);
    expect(body.summary).toBe("4 matches in 2 scanned files");
    expect(result.metadata).toMatchObject({
      path: "/workspace",
      query: "needle",
      matches: 4,
      scannedFiles: 2,
      skippedFiles: 0,
      complete: true,
      snippetCharacters: 240,
    });

    // Case folds by default; case_sensitive restores exactness.
    const folded = parseSearch((await tool.execute({ query: "NEEDLE" }, makeToolContext())).content);
    expect(folded.matches).toHaveLength(4);
    const exact = parseSearch((await tool.execute({ query: "NEEDLE", case_sensitive: true }, makeToolContext())).content);
    expect(exact.matches).toHaveLength(0);
    expect(exact.summary).toBe("0 matches in 2 scanned files");
    expect(exact.complete).toBe(true);
  });

  it("stops at the total scan budget naming nextCursor and the unsearched remainder", async () => {
    const workspace = new FakeWorkspacePort({
      "/workspace/a.txt": padTo("needle a\n", 40),
      "/workspace/b.txt": padTo("needle b\n", 40),
      "/workspace/c.txt": padTo("needle c\n", 40),
    });
    const tool = createPrimeSearchTextTool(workspace, {
      files: 512,
      fileBytes: 512 * 1_024,
      totalBytes: 66,
      defaultResults: 200,
      resultCeiling: 2_000,
    });
    const result = await tool.execute({ query: "needle" }, makeToolContext());
    const body = parseSearch(result.content);
    expect(body.complete).toBe(false);
    expect(body.nextCursor).toBe("/workspace/b.txt");
    expect(body.matches).toHaveLength(2);
    expect(body.summary).toContain("1 not reached by the bounded scan");
    expect(body.summary).toContain("stopped at the");
    expect(result.metadata).toMatchObject({
      complete: false,
      matches: 2,
      scannedFiles: 2,
      unsearchedFiles: 1,
      candidateFiles: 3,
      scannedBytes: 66,
    });
    expect(result.metadata).not.toHaveProperty("nextCursor");

    // The named action: resume after the cursor and the remainder completes.
    const resumed = parseSearch(
      (await tool.execute({ query: "needle", cursor: body.nextCursor as string }, makeToolContext())).content,
    );
    expect(resumed.complete).toBe(true);
    expect(resumed.matches).toHaveLength(1);
    expect(resumed.matches[0]?.path).toBe("/workspace/c.txt");
  });

  it("caps results at max_results and names the file the cap filled inside", async () => {
    const workspace = new FakeWorkspacePort({ "/workspace/hits.ts": "needle\nneedle\nneedle\nneedle" });
    const tool = createPrimeSearchTextTool(workspace);
    const result = await tool.execute({ query: "needle", max_results: 2 }, makeToolContext());
    const body = parseSearch(result.content);
    expect(body.complete).toBe(false);
    expect(body.capReachedIn).toBe("/workspace/hits.ts");
    expect(body.nextCursor).toBeUndefined();
    expect(body.matches).toHaveLength(2);
    expect(body.matches.map((match) => match.line)).toEqual([1, 2]);
    expect(result.metadata).toMatchObject({ complete: false, matches: 2 });
  });

  it("filters by include glob and refuses a pattern that selects nothing", async () => {
    const workspace = new FakeWorkspacePort({
      "/workspace/src/a.ts": "needle ts",
      "/workspace/b.md": "needle md",
    });
    const tool = createPrimeSearchTextTool(workspace);

    const included = parseSearch(
      (await tool.execute({ query: "needle", include: "*.ts" }, makeToolContext())).content,
    );
    expect(included.matches).toHaveLength(1);
    expect(included.matches[0]?.path).toBe("/workspace/src/a.ts");

    const tsResult = await tool.execute({ query: "needle", include: "*.ts" }, makeToolContext());
    expect(tsResult.metadata).toMatchObject({
      include: "*.ts",
      candidateFiles: 2,
      filteredOutFiles: 1,
      scannedFiles: 1,
      complete: true,
    });

    const empty = await tool.execute({ query: "needle", include: "*.rs" }, makeToolContext());
    expect(empty.isError).toBe(true);
    expect(empty.content).toBe(
      'search_text include "*.rs" selected 0 of 2 files under /workspace, so nothing was searched. ' +
        "Paths here look like /workspace/b.md, /workspace/src/a.ts. " +
        "A pattern matches the whole path: a bare name matches the file name (*.ts), ** spans directories (src/**/*.ts).",
    );
    expect(empty.metadata).toEqual({
      path: "/workspace",
      query: "needle",
      include: "*.rs",
      candidateFiles: 2,
      selectedFiles: 0,
    });
  });

  it("bounds what one file contributes to the per-file byte cap (later matches stay invisible)", async () => {
    const workspace = new FakeWorkspacePort({
      "/workspace/capped.txt": "needle\nxxxxxxxx\nneedle beyond the cap",
    });
    const tool = createPrimeSearchTextTool(workspace, {
      files: 512,
      fileBytes: 16,
      totalBytes: 4 * 1_024 * 1_024,
      defaultResults: 200,
      resultCeiling: 2_000,
    });
    const result = await tool.execute({ query: "needle" }, makeToolContext());
    const body = parseSearch(result.content);
    expect(body.complete).toBe(true);
    expect(body.matches).toEqual([{ path: "/workspace/capped.txt", line: 1, column: 1, snippet: "needle" }]);
    expect(body.summary).toBe("1 match in 1 scanned file");
    expect(result.metadata).toMatchObject({ scannedBytes: 16, complete: true });
  });
});
