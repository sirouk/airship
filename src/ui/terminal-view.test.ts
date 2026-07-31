import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrowserGitClient } from "../git/client";
import { WorkspaceGitAdapter } from "../git/workspace-adapter";
import type { GitOperation } from "../git/types";
import { MemoryWorkspace } from "../workspace/memory";
import {
  TERMINAL_CONTAINER_SCOPE_NOTICE,
  TERMINAL_SETUP_STORAGE_KEY,
  inferredTerminalDurability,
  readTerminalSetupOpen,
  runTerminalGitBridge,
  terminalCloseConfirmation,
  terminalEmulatorWrite,
  terminalFooterNotice,
  terminalGitHandoffSentence,
  terminalGitNotice,
  terminalPanelAutoStart,
  terminalPersistenceNotice,
  terminalSealState,
  terminalShellGitHandoff,
  terminalTypography,
} from "./terminal-view";

describe("terminal runtime band", () => {
  it("starts closed unless this browser stored a choice to open it", () => {
    expect(readTerminalSetupOpen(undefined)).toBe(false);
    expect(readTerminalSetupOpen({ getItem: () => null })).toBe(false);
    expect(readTerminalSetupOpen({ getItem: () => "closed" })).toBe(false);
    expect(readTerminalSetupOpen({ getItem: () => "open" })).toBe(true);
  });

  it("reads the choice under one stable key", () => {
    const seen: string[] = [];
    readTerminalSetupOpen({ getItem: (key) => { seen.push(key); return null; } });
    expect(seen).toEqual([TERMINAL_SETUP_STORAGE_KEY]);
  });

  it("treats a blocked storage as closed rather than as an error", () => {
    expect(readTerminalSetupOpen({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("terminal status in the one seal vocabulary", () => {
  it("maps every lifecycle state without inventing a verdict", () => {
    expect(terminalSealState("running")).toBe("verified");
    expect(terminalSealState("starting")).toBe("checking");
    expect(terminalSealState("failed")).toBe("failed");
    expect(terminalSealState("restart-required")).toBe("attention");
    // An exited process is a finished process, not a broken one.
    expect(terminalSealState("exited")).toBe("none");
  });
});

describe("terminal panel auto-start", () => {
  it("lets selection wake only sessions that were never or still alive", () => {
    // idle: never started. restart-required: was live when the page reloaded.
    expect(terminalPanelAutoStart("idle")).toBe(true);
    expect(terminalPanelAutoStart("restart-required")).toBe(true);
    // running/starting short-circuit inside manager.start anyway.
    expect(terminalPanelAutoStart("running")).toBe(true);
    expect(terminalPanelAutoStart("starting")).toBe(true);
    // Ended sessions own the explicit Restart control: selecting their tab is
    // for reading final output, not for silently spending it on a respawn.
    expect(terminalPanelAutoStart("exited")).toBe(false);
    expect(terminalPanelAutoStart("failed")).toBe(false);
  });
});

describe("terminal typography", () => {
  it("tracks the density preference", () => {
    expect(terminalTypography("comfortable").fontSize).toBe(15);
    expect(terminalTypography("compact").fontSize).toBe(12);
    expect(terminalTypography(undefined).fontSize).toBe(13);
  });
});

describe("terminal durability wording", () => {
  it("treats an unmarked workspace as ephemeral instead of claiming encryption", () => {
    const durability = inferredTerminalDurability(new MemoryWorkspace());
    expect(durability.state).toBe("ephemeral");
    expect(durability.detail).toContain("No durable or client-encrypted workspace capability");
    expect(terminalPersistenceNotice(durability, "profile-a")).toContain("Reload loses them");
    expect(terminalPersistenceNotice(durability, "profile-a")).not.toContain("retained through the active encrypted workspace");
  });

  it("recognizes only the explicit client-encryption marker without inventing its backing tier", () => {
    const workspace = Object.assign(new MemoryWorkspace(), {
      encryptionBoundary: "airship-client-envelope-v1" as const,
    });
    const durability = inferredTerminalDurability(workspace);
    expect(durability.state).toBe("local");
    expect(durability.label).toBe("Client-encrypted workspace · tier unknown");
    expect(durability.detail).toContain("backing tier was not supplied");
    expect(durability.detail).toContain("does not claim device or cloud synchronization");
    expect(terminalPersistenceNotice(durability, "profile-a")).toContain("Processes still restart after reload");
  });

  it("stops claiming retention the moment a durable write is observed to fail", () => {
    const retained = terminalPersistenceNotice(
      Object.freeze({ state: "local" as const, label: "Client-encrypted workspace" }),
      "profile-a",
    );
    expect(retained).toContain("are retained through the active encrypted workspace");

    const failing = terminalFooterNotice(retained, "The workspace storage quota is exhausted.");
    expect(failing).not.toContain("are retained through the active encrypted workspace");
    expect(failing).toContain("The workspace storage quota is exhausted.");
    // And the claim's only licence to return is the failure clearing.
    expect(terminalFooterNotice(retained, undefined)).toBe(retained);
  });
});

describe("terminal transcript rendering", () => {
  const capped = "y".repeat(256 * 1_024);

  it("writes only the appended chunk once the published tail has started sliding", () => {
    expect(terminalEmulatorWrite(41, { outputSequence: 42, appendedOutput: "0123456789", bufferedOutput: capped }))
      .toEqual({ kind: "append", text: "0123456789" });
  });

  it("says nothing when the sequence has not moved", () => {
    // Status, cwd and audit changes all re-emit the snapshot; none of them is
    // an append, and re-writing the buffer for one is how a redraw storm starts.
    expect(terminalEmulatorWrite(42, { outputSequence: 42, appendedOutput: "0123456789", bufferedOutput: capped }))
      .toEqual({ kind: "none" });
  });

  it("redraws exactly once for a first mount and for a reconstructed session", () => {
    expect(terminalEmulatorWrite(undefined, { outputSequence: 0, appendedOutput: "", bufferedOutput: "restored" }))
      .toEqual({ kind: "redraw", text: "restored" });
    // A discontinuity — a resubscribe that missed chunks — is the only other
    // case worth a full write.
    expect(terminalEmulatorWrite(10, { outputSequence: 14, appendedOutput: "late", bufferedOutput: capped }))
      .toEqual({ kind: "redraw", text: capped });
  });
});

describe("terminal profile boundary", () => {
  it("names the container filesystem outside the mount as page-shared", () => {
    // The mount is what a Profile handoff unmounts; the container around it is
    // booted once per page. Saying only the first half is the drift this guards.
    expect(TERMINAL_CONTAINER_SCOPE_NOTICE).toContain("Only the workspace mount is Profile-owned");
    expect(TERMINAL_CONTAINER_SCOPE_NOTICE).toContain("page-shared");
    expect(TERMINAL_CONTAINER_SCOPE_NOTICE).toContain("survives a Profile switch");
    expect(readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8"))
      .toContain("{TERMINAL_CONTAINER_SCOPE_NOTICE}");
  });
});

describe("the terminal tab strip", () => {
  it("takes tabs.tsx's rules rather than growing a second copy of them", () => {
    // The strip cannot adopt `Tabs` itself — a tab being renamed is replaced by
    // a text input and `TabItem` has no shape for that, while its one secondary
    // action hard-renders a close `×`. What it must not do is reimplement the
    // behaviour: movement and active-tab-into-view are one rule each, and they
    // live in `tabs.tsx` where they are measured and tested.
    const source = terminalViewCode();
    expect(source).toMatch(/import \{[^}]*nextTabId[^}]*\} from "\.\/tabs";/u);
    expect(source).toMatch(/import \{[^}]*tabScrollLeft[^}]*\} from "\.\/tabs";/u);
    // `scrollIntoView` is the tempting shortcut that also scrolls every
    // scrollable ancestor, so a strip below the fold takes the page with it.
    expect(source).not.toContain("scrollIntoView");
  });

  it("holds the reconcile predicate from the manager's signal, never a render-time read", () => {
    // Host authority and the mount are not session state; a render-time
    // `canReconcile()` is only ever right when some other emission happens to
    // land at the same moment, and on a cold boot it does not.
    const source = terminalViewCode();
    expect(source).toContain("manager.subscribeReconcile(setReconcilable)");
    expect(source).not.toMatch(/disabled=\{[^}]*manager\.canReconcile\(\)/u);
  });
});

/**
 * The view's code without its prose.
 *
 * This repo explains itself in comments, and the comments here name the very
 * API the checks above forbid — `scrollIntoView` is banned in the code and
 * quoted in the reason. Reading the file raw would make the explanation the
 * violation.
 */
function terminalViewCode(): string {
  return readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|\s)\/\/[^\n]*/gu, "$1");
}

describe("terminal panel bar at phone width", () => {
  it("sheds the labels without shedding the glyph that stands in for them", () => {
    // `button span` also hid the `＋` of "New here", whose mark happens to live
    // in a span — an empty 44px box on every phone and in the workspace dock.
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toContain('.terminal-panel__bar button span:not([aria-hidden="true"]){display:none}');
    expect(css).not.toMatch(/\.terminal-panel__bar button span\{display:none\}/u);
  });
});

describe("the full-view control a thumb has to hit", () => {
  /*
   * Measured at 390×844: 29×44. The rule that hides its word on a phone left a
   * bare ↗ inside 7px of padding, so the height floor was met and the width was
   * 15px short — and a target's SMALLER dimension is the one a fingertip has to
   * find. The same control renders in three places, and all three are floored.
   */
  /*
   * Asserted as the token, not as the number. These pinned the literal
   * `min-height:44px`, so converting the sheet to `var(--touch-target)` — the
   * name the floor is supposed to have, and the thing token-vocabulary.test.ts
   * counts down — turned three passing contracts red for being fixed. A
   * reference cannot drift; a copied number is how 144 of them accumulated.
   */
  it("meets 44px on both axes wherever it renders", () => {
    const dock = readFileSync(new URL("./workspace-terminal-dock.css", import.meta.url), "utf8");
    const dockPhone = dock.slice(dock.indexOf("@media(max-width:760px)"));
    expect(dockPhone).toContain(".workspace-terminal-dock__collapsed button{min-width:var(--touch-target);min-height:var(--touch-target)");
    expect(dockPhone).toContain(".workspace-terminal-dock__loading button{min-width:var(--touch-target);min-height:var(--touch-target)}");

    const route = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const routePhone = route.slice(route.indexOf("@media(max-width:760px)"));
    expect(routePhone).toContain(".terminal-dock__actions button{min-width:var(--touch-target);min-height:var(--touch-target)");
    expect(routePhone).not.toContain("min-height:38px");
  });
});

describe("the Browser Git row's own controls", () => {
  it("floors the command field at the same 44px as the button beside it", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toContain(".terminal-git__command{min-width:0;min-height:var(--touch-target)");
    // The route's shared button rule already carries the floor, so the Run
    // button must not restate it — a second literal is a second thing to drift.
    expect(css).toContain(".terminal-route button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:var(--touch-target)");
  });
});

describe("the tab rename affordance on touch surfaces", () => {
  /*
   * 34px wide, no height, and invisible until hover: the rename control had
   * no reachable path on a device that cannot hover. The phone block lifts it
   * to the same 44px square as its neighbours, and a coarse pointer anywhere
   * keeps it painted — an affordance that only exists under hover is an
   * affordance a touchscreen never sees.
   */
  it("grows to the 44px phone floor and shows itself without a hover", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media(max-width:760px)"));
    expect(phone).toContain(".terminal-tab .terminal-tab__rename{min-width:var(--touch-target);min-height:var(--touch-target);opacity:1}");
    expect(css).toContain("@media(pointer:coarse){.terminal-tab .terminal-tab__rename{opacity:1}}");
  });
});

/*
 * 836 lines, seventeen verb families, approval-gated and unit-tested — and the
 * only reference to `runTerminalGitCommand` outside its own test file was its
 * own `export`. stash, merge, tag, reset, restore, rev-parse and remote
 * management shipped with no human path on any device, which is a deleted
 * feature that still costs review. These assert the entry point, not the
 * bridge's verbs: `git/terminal-commands.test.ts` owns those.
 */
describe("the shared Git bridge's entry point", () => {
  it("is reached from non-test application source, not only from its own test", () => {
    const callers = sourceFilesReferencing("runTerminalGitCommand");
    expect(callers.length).toBeGreaterThanOrEqual(1);
    expect(callers).toContain("ui/terminal-view.tsx");
  });

  it("hands the row the active approval policy rather than the bridge's optional default", () => {
    // The comment that stood on these props — "Retained for app compatibility"
    // — was the audit trail of the deletion: two threaded props, no consumer.
    // The rule it also carried (bridge output never enters PTY scrollback) is
    // still true and still stated; the compatibility excuse is gone.
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("Retained for app compatibility");
    expect(source).toContain("runTerminalGitBridge({ command, cwd: gitCwd, client: git, review: reviewGit })");
  });

  it("keeps the row on the route and off the 220px dock strip", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).toContain('{variant === "route" ? <form class="terminal-git"');
  });
});

describe("the Terminal route's Git command row", () => {
  const openRepository = async (files: Record<string, string> = { "README.md": "ready\n" }) =>
    new BrowserGitClient(await WorkspaceGitAdapter.open(new MemoryWorkspace(), [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files,
    }]));
  const allow = async () => "allow" as const;

  it("renders the supported command set, including what is absent", async () => {
    const outcome = await runTerminalGitBridge({
      command: "git help",
      cwd: "/workspace",
      client: await openRepository(),
      review: allow,
    });
    expect(outcome.failed).toBe(false);
    expect(outcome.output).toContain("git stash");
    expect(outcome.output).toContain("git worktree list");
    expect(outcome.output).toContain("git rev-parse");
    // The set has to name its own holes, or the row becomes a second place to
    // discover that `git rebase` was never implemented.
    expect(outcome.output).toContain("Not implemented here: rebase");
  });

  it("returns the bridge's own answer for a verb with no other surface", async () => {
    // Nothing else in the product lists stash entries; before the row existed
    // this answer was reachable only from a unit test.
    const outcome = await runTerminalGitBridge({
      command: "git stash list",
      cwd: "/workspace",
      client: await openRepository(),
      review: allow,
    });
    expect(outcome.failed).toBe(false);
    expect(outcome.changed).toBe(false);
    expect(outcome.output).toContain("No stash entries.");
  });

  it("puts every mutating verb through the review callback it was given", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "changed\n");
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "original\n" },
      workingFiles: { "README.md": "changed\n" },
    }]));
    const reviewed: GitOperation["kind"][] = [];
    const outcome = await runTerminalGitBridge({
      command: "git add -A",
      cwd: "/workspace",
      client,
      review: async (operation) => { reviewed.push(operation.kind); return "deny"; },
    });
    expect(reviewed).toEqual(["stage"]);
    // A denial that only throws is indistinguishable from a command that
    // silently did nothing, so it has to arrive as an answer.
    expect(outcome.failed).toBe(true);
    expect(outcome.output).toContain("denied");
    expect(terminalGitNotice(outcome)).toContain("git was refused at /workspace");
    expect((await client.listRepositories())[0]!.worktrees[0]!.status[0])
      .toEqual(expect.objectContaining({ worktree: { kind: "modified" } }));
  });

  it("reports a refusal instead of throwing at the surface", async () => {
    const outcome = await runTerminalGitBridge({
      command: "git rebase main",
      cwd: "/workspace",
      client: await openRepository(),
      review: allow,
    });
    expect(outcome.failed).toBe(true);
    expect(outcome.output).toContain("Unsupported shared Git command: git rebase");
    expect(outcome.changed).toBe(false);
  });

  it("distinguishes an answer from a change in the one line the footer shows", () => {
    const read = terminalGitNotice({ command: "git status", cwd: "/workspace", output: "", changed: false, failed: false });
    expect(read).toContain("without changing it");
    const wrote = terminalGitNotice({ command: "git add -A", cwd: "/workspace", output: "", changed: true, failed: false });
    expect(wrote).toContain("changed the browser-owned repository");
    expect(wrote).toContain("Editor, source control and the agent read that same state");
  });
});

/**
 * Every non-test `.ts`/`.tsx` under `src/` that names a symbol, excluding the
 * module that defines it. Paths are returned relative to `src/` so a failure
 * names the caller that went missing rather than an absolute machine path.
 */
function sourceFilesReferencing(symbol: string): string[] {
  const found: string[] = [];
  const walk = (directory: URL, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name) || /\.(?:test|spec)\.tsx?$/u.test(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      if (path === "git/terminal-commands.ts") continue;
      if (readFileSync(new URL(entry.name, directory), "utf8").includes(symbol)) found.push(path);
    }
  };
  walk(new URL("../", import.meta.url), "");
  return found;
}

/*
 * Closing a terminal tab ended a live process and its shell history on the
 * first press, while deleting one workspace file two panes away opened a
 * designed modal naming the revision check. One product, one finger, no way to
 * read the danger off the button.
 */
describe("closing a terminal tab", () => {
  const session = { name: "shell", status: "running" as const, cwd: "/workspace/sources/repo" };

  it("states the same fact before the act that the receipt states after it", () => {
    const ephemeral = terminalCloseConfirmation(session, { state: "ephemeral" });
    expect(ephemeral.title).toBe("Close shell?");
    expect(ephemeral.consequence).toContain("/workspace/sources/repo");
    expect(ephemeral.consequence).toContain("bounded lineage remains only for this page and workspace lifetime");
    expect(terminalCloseConfirmation(session, { state: "local" }).consequence)
      .toContain("retained by the active encrypted workspace");
  });

  it("does not claim to end a process that already ended", () => {
    const exited = terminalCloseConfirmation({ ...session, status: "exited" }, { state: "ephemeral" });
    expect(exited.consequence).toContain("already ended");
    expect(exited.consequence).not.toContain("This ends the process");
  });

  it("gates the close button on the shared confirmation instead of calling the manager", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-label="Close terminal tab">');
    // The press opens the dialog; only the dialog's confirm reaches the manager.
    expect(source).toContain("onClick={() => setClosing(true)} aria-label=\"Close terminal tab\"");
    expect(source).toMatch(/onConfirm=\{\(\) => \{ setClosing\(false\); closeButton\.current\?\.focus\(\); void close\(\); \}\}/u);
    expect(source).toContain('import { ConfirmDialog } from "./confirm-dialog";');
  });
});

/*
 * One workspace was described by three mutually contradictory absolute paths in
 * a single frame — chip "/workspace", prompt "~/airship-node/airship-workspace",
 * Git note "/workspace" — and the one printed most prominently was the one
 * `ls` could not find. The shell's own chrome now leads with the path `pwd`
 * prints, and every surface that names the other spelling names it as the same
 * directory rather than as a second one.
 */
describe("one workspace, one identity, two spellings", () => {
  const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");

  it("prints the shell's own path in the shell's own status bar", () => {
    expect(source).toContain("<code aria-hidden=\"true\" title={workspaceAddressNote(session.cwd)}>{terminalShellPath(session.cwd)}</code>");
    // The workspace spelling stays beside it — removing either one is how the
    // contradiction returns.
    expect(source).toContain('<span class="terminal-panel__mirror" aria-hidden="true">= {session.cwd}</span>');
    expect(source).toContain('<span class="sr-only">{workspaceAddressNote(session.cwd)}</span>');
  });

  it("names both spellings wherever a sentence spans the shell and the workspace", () => {
    const closing = terminalCloseConfirmation({ name: "shell", status: "running", cwd: "/workspace/sources/repo" }, { state: "ephemeral" });
    expect(closing.consequence).toContain("/home/airship-node/airship-workspace/sources/repo");
    expect(closing.consequence).toContain("/workspace/sources/repo in Explorer");
  });

  it("keeps the Git bridge's scope note naming the directory the shell resolves", () => {
    expect(source).toContain("the same directory the {WEB_CONTAINER_TERMINAL_RUNTIME.shellLabel} process calls <code>{terminalShellPath(gitCwd)}</code>");
  });
});

/*
 * `git status` is the likeliest first command on this route, and jsh answered
 * it with "jsh: command not found: git" while the bridge that can answer it sat
 * 200px below with `git status` as its placeholder. The refusal is a seam now.
 */
describe("a git the shell cannot run", () => {
  it("lifts only the most recent submitted git line", () => {
    expect(terminalShellGitHandoff(["ls", "git status"])).toBe("git status");
    expect(terminalShellGitHandoff(["  git log --oneline  "])).toBe("git log --oneline");
    expect(terminalShellGitHandoff(["git"])).toBe("git");
  });

  it("does not offer the bridge a command that is not git, or a stale one", () => {
    expect(terminalShellGitHandoff(["git status", "ls"])).toBeUndefined();
    expect(terminalShellGitHandoff(["gitalias status"])).toBeUndefined();
    expect(terminalShellGitHandoff([])).toBeUndefined();
    expect(terminalShellGitHandoff(undefined)).toBeUndefined();
  });

  it("says the same thing in both places it makes the offer", () => {
    expect(terminalGitHandoffSentence("git status")).toBe("git status needs Browser Git: this jsh process has no git binary.");
  });

  it("stands where the scope paragraph stood, keeping the field's description", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    // Added as an extra row it cost 114px, and this route's grid is
    // height-locked: at 390x844 the browser took those pixels out of the tab
    // strip, crushing a 44px tab to 23px.
    expect(source).toContain('<p class="notice terminal-git__handoff" id="terminal-git-scope"');
    expect(source).toContain('aria-describedby="terminal-git-scope"');
    expect(source.match(/id="terminal-git-scope"/gu)).toHaveLength(2);
  });

  it("offers the lifted line to the bridge on both the route and the dock", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    // Route: fills the field and runs it, so the answer lands in the region
    // that already exists for bridge output rather than in the PTY scrollback.
    expect(source).toContain("setGitCommand(gitHandoff);");
    expect(source).toContain("void runGit(gitHandoff);");
    // Dock: it owns no command row, so the refusal routes to the view that does
    // instead of dead-ending a second time.
    expect(source).toContain('{variant === "dock" && gitHandoff ?');
  });
});
