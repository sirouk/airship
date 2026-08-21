import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import { TERMINAL_WORKSPACE_MOUNT } from "../terminal/contracts";
import { mountTerminalWorkspace } from "../terminal/workspace-sync";
import { MemoryWorkspace } from "./memory";
import {
  AIRSHIP_WORKSPACE_ROOT,
  TERMINAL_SHELL_HOME,
  TERMINAL_SHELL_ROOT,
  terminalShellPath,
  workspaceAddressNote,
} from "./addressing";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

describe("one workspace, two spellings", () => {
  /**
   * The defect this whole module exists for was a *drifted* string, so the
   * regression fence has to be the boot option itself rather than a copy of it.
   * WebContainer roots the container at `/home/<workdirName>`; if that name
   * moves, every path Airship prints for the shell becomes a lie again, and
   * this fails before anyone can see it in a screenshot.
   */
  it("derives the shell home from the workdir the WebContainer host actually boots", () => {
    const pack = readFileSync(resolve(sourceRoot, "../execution/node-webcontainer-pack.ts"), "utf8");
    const workdir = /workdirName:\s*"([^"]+)"/u.exec(pack)?.[1];
    expect(workdir).toBeTruthy();
    expect(TERMINAL_SHELL_HOME).toBe(`/home/${workdir!}`);
    expect(TERMINAL_SHELL_ROOT).toBe(`${TERMINAL_SHELL_HOME}/${TERMINAL_WORKSPACE_MOUNT}`);
  });

  it("maps every workspace path onto the path the shell resolves", () => {
    expect(terminalShellPath(AIRSHIP_WORKSPACE_ROOT)).toBe("/home/airship-node/airship-workspace");
    expect(terminalShellPath("/workspace/docs")).toBe("/home/airship-node/airship-workspace/docs");
    expect(terminalShellPath("/workspace/docs/architecture.md")).toBe("/home/airship-node/airship-workspace/docs/architecture.md");
  });

  it("never throws on a directory the terminal manager already accepted", () => {
    // A panel bar that crashes on an odd cwd is worse than one that names the
    // mount root, which is where such a session is standing anyway.
    expect(terminalShellPath("/etc/passwd")).toBe(TERMINAL_SHELL_ROOT);
    expect(terminalShellPath("")).toBe(TERMINAL_SHELL_ROOT);
  });

  it("states both spellings in one sentence so no surface invents a second wording", () => {
    expect(workspaceAddressNote("/workspace/docs")).toBe(
      "/home/airship-node/airship-workspace/docs in the shell is the same directory as /workspace/docs"
      + " in Explorer, the Editor and Source Control, except a folder you attached from this device.",
    );
  });

  /*
   * The sentence has to survive the fence that contradicts it.
   *
   * The Terminal panel printed "…is the same directory as /workspace in
   * Explorer, the Editor and Source Control" while `ls
   * /workspace/local/<folder>` in that same shell answered "No such file or
   * directory" — because the mount deliberately filters every attached-folder
   * path out, and the write-back refuses anything addressed into one. The
   * fence is the product working as designed; the sentence was the stale part,
   * and it is the sentence a screen reader is handed as the panel's `sr-only`
   * text.
   *
   * So the claim is asserted against the mount itself. Change the fence and
   * this fails; change the sentence away from the fence and this fails too.
   */
  it("names the one part of the workspace the shell does not hold, and means it", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "in the shell\n", { expectedRevision: null });
    await workspace.write("local/notes/salary.txt", "not in the shell\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { mounted = {}; } },
      async mount(tree: FileSystemTree, _options: { mountPoint: string }) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
    };

    await mountTerminalWorkspace(host, workspace);

    // Explorer lists both; the shell was given exactly one of them.
    expect((await workspace.list("/workspace")).map((entry) => entry.path))
      .toEqual(expect.arrayContaining(["/workspace/README.md", "/workspace/local/notes/salary.txt"]));
    expect(mounted).toHaveProperty("README.md");
    expect(mounted).not.toHaveProperty("local");

    const note = workspaceAddressNote("/workspace");
    expect(note).toContain("except a folder you attached from this device");
  });
});
