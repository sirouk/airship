import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes } from "./content-codec";
import { searchWorkspaceContent, workspaceSearchSummary, WORKSPACE_SEARCH_LIMITS } from "./content-search";
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

  it("abandons the scan when the caller aborts, without throwing", async () => {
    const workspace = await seeded({ "/workspace/a.ts": "airship", "/workspace/b.ts": "airship" });
    const controller = new AbortController();
    controller.abort();
    const result = await searchWorkspaceContent(workspace, await workspace.list("/workspace"), "airship", { signal: controller.signal });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("names every bound that fired in one sentence", () => {
    expect(workspaceSearchSummary({ matches: [], scannedFiles: 1, skippedFiles: 0, truncated: false }))
      .toBe("0 matches · 1 file read");
    expect(workspaceSearchSummary({ matches: [{ path: "/workspace/a", line: 1, column: 1, snippet: "a" }], scannedFiles: 2, skippedFiles: 3, truncated: true }))
      .toBe("1 match · 2 files read · 3 skipped as binary or oversized · bounded scan");
  });
});
