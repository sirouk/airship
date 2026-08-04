import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes } from "./content-codec";
import {
  searchWorkspaceContent,
  workspacePathGlobMatcher,
  workspaceSearchSummary,
  WORKSPACE_SEARCH_LIMITS,
  type WorkspaceContentSearch,
} from "./content-search";
import { MemoryWorkspace } from "./memory";

async function seeded(files: Readonly<Record<string, string>>) {
  const workspace = new MemoryWorkspace();
  for (const [path, content] of Object.entries(files)) await workspace.write(path, content);
  return workspace;
}

describe("workspace content search", () => {
  it("finds a literal that exists only inside a file body, with its line number", async () => {
    /*
     * The Explorer's only search was `workbenchFilterMatches`, which reduces to
     * `files.filter((entry) => entry.path.includes(needle))` — so a developer
     * looking for where a symbol is used got filename matches and concluded the
     * product cannot grep. `notes.md` does not contain "renderReceipt" in its
     * path; the path filter can never return it.
     */
    const workspace = await seeded({
      "/workspace/notes.md": "intro\ncall renderReceipt() here\ntail",
      "/workspace/other.md": "nothing relevant",
    });
    const result = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "renderReceipt");
    expect(result.matches).toEqual([{
      path: "/workspace/notes.md",
      line: 2,
      column: 6,
      snippet: "call renderReceipt() here",
    }]);
    expect(result.scannedFiles).toBe(2);
  });

  it("matches case-insensitively by default and exactly when asked", async () => {
    const workspace = await seeded({ "/workspace/a.ts": "export const Airship = 1;" });
    const entries = await workspace.list("/workspace");
    expect((await searchWorkspaceContent(workspace, entries, "airship")).matches).toHaveLength(1);
    expect((await searchWorkspaceContent(workspace, entries, "airship", { caseSensitive: true })).matches).toHaveLength(0);
  });

  it("never searches the storage envelope of a binary, and counts what it skipped", async () => {
    // The envelope is base64 text: searching it would report matches for a
    // string no human typed and no editor could reveal.
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/image.png", encodeWorkspaceBytes(Uint8Array.from([0, 255, 1, 2])));
    await workspace.write("/workspace/readme.md", "airship");
    const result = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "airship");
    expect(result.matches.map((match) => match.path)).toEqual(["/workspace/readme.md"]);
    expect(result.skippedFiles).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("returns nothing for an empty query rather than every line in the workspace", async () => {
    const workspace = await seeded({ "/workspace/a.ts": "one\ntwo" });
    const result = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "");
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("stops at the shared result bound and says the scan was bounded", async () => {
    const line = "airship\n";
    const workspace = await seeded({ "/workspace/many.txt": line.repeat(WORKSPACE_SEARCH_LIMITS.results + 25) });
    const result = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "airship");
    // Asserted against the constant, not a copy of it: the tool and this control
    // must be bounded by the same number or one of them is lying about "all".
    expect(result.matches).toHaveLength(WORKSPACE_SEARCH_LIMITS.results);
    expect(result.truncated).toBe(true);
    expect(workspaceSearchSummary(result)).toContain("bounded scan");
  });

  it("honours a caller's larger bound up to the shared ceiling", async () => {
    /*
     * `search_text` declared `maximum: 200` before this scan was shared. A
     * ceiling of `results` here would have halved that tool's documented maximum
     * on the day it delegated, and nothing in its own tests would have said so.
     */
    const workspace = await seeded({ "/workspace/many.txt": "airship\n".repeat(WORKSPACE_SEARCH_LIMITS.resultCeiling + 10) });
    const entries = await workspace.list("/workspace");
    expect((await searchWorkspaceContent(workspace, entries, "airship", { maxResults: 120 })).matches)
      .toHaveLength(120);
    expect((await searchWorkspaceContent(workspace, entries, "airship", { maxResults: 10_000 })).matches)
      .toHaveLength(WORKSPACE_SEARCH_LIMITS.resultCeiling);
  });

  it("names the file the result cap filled inside, because there is no finished file to resume after", async () => {
    /*
     * Measured against the first draft of this change: a cap that filled inside
     * the *first* eligible file left `nextCursor` undefined, so the result was
     * `truncated: true` with no way to continue — an incomplete answer that
     * names no next action, which is the defect this whole lane exists to
     * remove. The invariant is asserted, not the field alone.
     */
    const workspace = await seeded({ "/workspace/many.md": "airship\n".repeat(40) });
    const capped = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "airship", { maxResults: 4 });
    expect(capped.matches).toHaveLength(4);
    expect(capped.capReachedIn).toBe("/workspace/many.md");
    expect(capped.nextCursor).toBeUndefined();
    expect(capped.truncated).toBe(true);
    expect(capped.nextCursor ?? capped.capReachedIn).toBeDefined();
    expect(workspaceSearchSummary(capped)).toContain("result cap reached inside");
  });

  it("resumes after the last file it finished, and the two halves are the whole", async () => {
    const workspace = await seeded({
      "/workspace/a.md": "airship one",
      "/workspace/b.md": "airship two",
      "/workspace/c.md": "airship three",
    });
    const entries = await workspace.list("/workspace");
    const first = await searchWorkspaceContent(workspace, entries, "airship", { maxResults: 1 });
    // The cap fired inside a.md, so the cursor may not step past it.
    expect(first.capReachedIn).toBe("/workspace/a.md");
    const second = await searchWorkspaceContent(workspace, entries, "airship", { cursor: "/workspace/a.md" });
    expect(second.matches.map((match) => match.path)).toEqual(["/workspace/b.md", "/workspace/c.md"]);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("selects with a glob before the file bound, and counts what the filter rejected", async () => {
    const workspace = await seeded({
      "/workspace/docs/readme.md": "airship",
      "/workspace/src/a.ts": "airship",
      "/workspace/src/deep/deeper/b.ts": "airship",
    });
    const entries = await workspace.list("/workspace");
    const result = await searchWorkspaceContent(workspace, entries, "airship", { include: "src/**/*.ts" });
    expect(result.matches.map((match) => match.path)).toEqual(["/workspace/src/a.ts", "/workspace/src/deep/deeper/b.ts"]);
    expect(result.candidateFiles).toBe(3);
    expect(result.filteredOutFiles).toBe(1);
    expect(workspaceSearchSummary(result)).toContain("2 of 3 files matched the filter");
  });

  it("reports the selection a relative glob makes, measured against the shapes a model writes", () => {
    /*
     * The first draft compiled `src/**` and `src/**\/*.ts` to a pattern with no
     * anchor for the leading empty segment of an absolute path, so every
     * multi-segment relative pattern selected 0 of these 4 paths and the scan
     * then reported a confident, complete, empty result. This table is the
     * measurement, kept beside the code it corrects.
     */
    const paths = ["/workspace/src/a.ts", "/workspace/src/deep/deeper/a.ts", "/workspace/docs/readme.md", "/workspace/package.json"];
    const select = (pattern: string) => paths.filter((path) => workspacePathGlobMatcher(pattern)(path));
    expect(select("src/**")).toEqual([paths[0], paths[1]]);
    expect(select("src/**/*.ts")).toEqual([paths[0], paths[1]]);
    expect(select("docs/*.md")).toEqual([paths[2]]);
    expect(select("/workspace/src/**/*.ts")).toEqual([paths[0], paths[1]]);
    expect(select("*.ts")).toEqual([paths[0], paths[1]]);
    expect(select("src/*.ts")).toEqual([paths[0]]);
    // A leading `./` is not a path segment anywhere in this workspace, so it
    // selects nothing — the caller is told that rather than shown zero matches.
    expect(select("./src/*.ts")).toEqual([]);
  });

  it("cannot be frozen by a pathological pattern, because it never compiles a RegExp", () => {
    /*
     * `/(?:.*a){12}.*b/` against this path is the classic catastrophic
     * backtrack, and one `exec` on the agent's thread cannot be interrupted.
     * The segment matcher backtracks over one star at a time; measured under 20ms
     * where a compiled RegExp did not return.
     */
    const matcher = workspacePathGlobMatcher(`${"*a".repeat(12)}*b`);
    const path = `/workspace/${"a".repeat(2000)}.ts`;
    const started = performance.now();
    expect(matcher(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("abandons the scan when the caller aborts, without throwing", async () => {
    const workspace = await seeded({ "/workspace/a.ts": "airship", "/workspace/b.ts": "airship" });
    const controller = new AbortController();
    controller.abort();
    const result = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "airship", { signal: controller.signal });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("names every bound that fired in one sentence", () => {
    const base: WorkspaceContentSearch = {
      matches: [],
      scannedFiles: 1,
      skippedFiles: 0,
      truncated: false,
      unsearchedFiles: 0,
      candidateFiles: 1,
      filteredOutFiles: 0,
    };
    expect(workspaceSearchSummary(base)).toBe("0 matches · 1 file read");
    expect(workspaceSearchSummary({
      ...base,
      matches: [{ path: "/workspace/a", line: 1, column: 1, snippet: "a" }],
      scannedFiles: 2,
      skippedFiles: 3,
      truncated: true,
      candidateFiles: 5,
    })).toBe("1 match · 2 files read · 3 skipped as binary or oversized · bounded scan");
    /*
     * The filter clause is not decoration. `content` is the only field the model
     * receives (src/core/agent.ts:941-943), so a scan that opened nothing because
     * a glob selected nothing must not be able to say "0 matches · 0 files read"
     * and stop there.
     */
    expect(workspaceSearchSummary({ ...base, scannedFiles: 0, candidateFiles: 9, filteredOutFiles: 7, truncated: true }))
      .toBe("0 matches · 0 files read · 2 of 9 files matched the filter · bounded scan");
  });
});
