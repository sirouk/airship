import { describe, expect, it } from "vitest";

import { normalizeWorkspacePath } from "./contracts";

/*
 * Pass 3 — adversarial load for the one chokepoint every workspace reader and
 * writer passes through. Twenty-six call sites in this repository resolve
 * model-supplied and vault-supplied relative paths through this function; a
 * single helper failure here would let one hostile payload escape /workspace.
 *
 * The contract each assertion locks:
 *  - anything that could mean a parent directory, however spelled, fails closed
 *  - control characters and NUL never survive planting
 *  - a normal document path continues to resolve, because a traversal panic
 *    that eats legitimate file names is only a quieter denial of service
 */
describe("adversarial workspace paths", () => {
  it("fails closed for every traversal spelling", () => {
    for (const hostile of [
      "..",
      "../x",
      "a/../b",
      "a/./b",
      ".",
      "/dev/shm/x",
      "a//../b",
      "..anything/../x",
      "\\workspace\\x",
      "a/b/../../c",
      "workspace/../x",
      // A sibling prefix on an absolute path fails the same door: it names a
      // root next to /workspace, and the rule is prefixes, not text overlap.
      "/workspace-other/x",
    ]) {
      expect(() => normalizeWorkspacePath(hostile), hostile).toThrow();
    }
  });

  it("fails closed for control characters and NUL", () => {
    for (const hostile of [
      "x\0y",
      "xy",
      "xy",
      "x\ny",
      "x\ty",
    ]) {
      expect(() => normalizeWorkspacePath(hostile), JSON.stringify(hostile)).toThrow();
    }
  });

  it("treats dots, percent escapes and lookalikes in file names as ordinary files", () => {
    // The sibling-prefix trap of string startsWith implementations lands on
    // the relative form: `workspace-other` is a directory inside the root.
    expect(normalizeWorkspacePath("workspace-other/x")).toBe("/workspace/workspace-other/x");
    expect(normalizeWorkspacePath("notes/report.md")).toBe("/workspace/notes/report.md");
    expect(normalizeWorkspacePath("/workspace/a.b.txt")).toBe("/workspace/a.b.txt");
    // Percent escapes are never decoded anywhere in the pipeline — this stays
    // a literal file name, which is exactly why no path can escape through it.
    expect(normalizeWorkspacePath("/workspace/%2e%2e/x")).toBe("/workspace/%2e%2e/x");
  });

  it("holds the boundary on the longest normal name the store will accept", () => {
    const resolved = normalizeWorkspacePath(`/workspace/${"a".repeat(240)}`);
    expect(resolved.startsWith("/workspace/")).toBe(true);
    expect(resolved).toHaveLength("/workspace/".length + 240);
  });
});
