import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TERMINAL_WORKSPACE_MOUNT } from "../terminal/contracts";
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
      "/home/airship-node/airship-workspace/docs in the shell is the same directory as /workspace/docs in Explorer, the Editor and Source Control.",
    );
  });
});
