import { TERMINAL_WORKSPACE_MOUNT } from "../terminal/contracts";
import { normalizeWorkspacePath } from "./contracts";

/**
 * The one address for the workspace: what Explorer, the Editor, Source Control,
 * the browser Git bridge and every agent tool mean by a path.
 *
 * `normalizeWorkspacePath` already enforces this prefix; naming it here gives
 * the surfaces that *print* it something to import instead of another literal.
 */
export const AIRSHIP_WORKSPACE_ROOT = "/workspace";

/**
 * Where the interactive shell actually stands.
 *
 * WebContainer roots every path it has under `/home/<workdirName>`, and
 * `node-webcontainer-pack.ts` boots it with `workdirName: "airship-node"`, so
 * no mount can make the shell resolve `/workspace`. The measured defect this
 * fixes: one frame described one directory with three absolute paths — the tab
 * chip read `/workspace`, the prompt read `~/airship-node/airship-workspace`
 * and the Browser Git note read `/workspace` again — while `pwd` answered
 * `/home/airship-node/airship-workspace` and `ls /workspace` failed.
 *
 * The boot option cannot import this constant without an edit to a file this
 * change does not own, so `addressing.test.ts` reads the pack's source and
 * fails if the two ever disagree.
 */
export const TERMINAL_SHELL_HOME = "/home/airship-node";

/** The shell's spelling of {@link AIRSHIP_WORKSPACE_ROOT}, exactly as `pwd` prints it. */
export const TERMINAL_SHELL_ROOT = `${TERMINAL_SHELL_HOME}/${TERMINAL_WORKSPACE_MOUNT}`;

/**
 * A workspace path in the shell's spelling.
 *
 * Total by construction: a surface rendering a session's directory must never
 * be able to throw on a path the terminal manager already accepted, so an
 * unparseable value falls back to the mount root rather than taking the panel
 * down.
 */
export function terminalShellPath(workspacePath: string): string {
  let normalized: string;
  try {
    normalized = normalizeWorkspacePath(workspacePath);
  } catch {
    return TERMINAL_SHELL_ROOT;
  }
  const relative = normalized === AIRSHIP_WORKSPACE_ROOT ? "" : normalized.slice(AIRSHIP_WORKSPACE_ROOT.length + 1);
  return relative ? `${TERMINAL_SHELL_ROOT}/${relative}` : TERMINAL_SHELL_ROOT;
}

/**
 * One sentence naming both spellings of one directory.
 *
 * Every surface that shows a shell path and a workspace path in the same frame
 * uses this, so the product cannot grow a second wording for the same identity.
 */
export function workspaceAddressNote(workspacePath: string): string {
  let normalized: string;
  try {
    normalized = normalizeWorkspacePath(workspacePath);
  } catch {
    normalized = AIRSHIP_WORKSPACE_ROOT;
  }
  return `${terminalShellPath(normalized)} in the shell is the same directory as ${normalized} in Explorer, the Editor and Source Control.`;
}
