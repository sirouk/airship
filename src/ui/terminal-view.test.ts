import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrowserGitClient } from "../git/client";
import { WorkspaceGitAdapter } from "../git/workspace-adapter";
import type { GitOperation } from "../git/types";
import { MemoryWorkspace } from "../workspace/memory";
import {
  TERMINAL_CONTAINER_SCOPE_NOTICE,
  TERMINAL_GIT_BOUNDARY_NOTICE,
  TERMINAL_SETUP_STORAGE_KEY,
  inferredTerminalDurability,
  readTerminalSetupOpen,
  runTerminalGitBridge,
  terminalCloseConfirmation,
  terminalEmulatorWrite,
  terminalFooterNotice,
  terminalGitNotice,
  terminalPanelAutoStart,
  terminalPersistenceNotice,
  terminalSealState,
  terminalTypography,
  terminalUnreconciledInputs,
  TERMINAL_KEYBOARD_OWNERSHIP,
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

/*
 * Every verb on this route ends in the footer, including the ones that fail.
 *
 * The footer is the only place this surface speaks, and the manager's refusals
 * are written as sentences to a person — "The previous browser shell is still
 * stopping", "This terminal has a writer heartbeat from another page or device",
 * "Terminal metadata supports at most 24 retained sessions across profiles". A
 * verb that drops one of those leaves the reader with a control that appears to
 * do nothing, and the remedy sitting in a console they will never open.
 */
describe("the terminal's process verbs report their own refusals", () => {
  it("gives Restart and Interrupt the rejection arm the auto-start beside them has", () => {
    const source = terminalViewCode();
    expect(source).toMatch(/manager\.restart\(session\.id, dimensions\(\)\)\s*\.catch\(\(error\) => onNotice\(/u);
    expect(source).toContain('"Terminal could not restart."');
    expect(source).toContain("manager.interrupt(session.id).catch((error) => onNotice(");
    expect(source).toContain('"Interrupt was not delivered."');
  });

  it("narrates the cross-profile session cap the New buttons cannot see", () => {
    // `disabled={sessions.length >= 8}` is fed by a profile-scoped list, so the
    // 24-session cap across profiles is reachable with the control enabled — and
    // the empty state's button carries no `disabled` at all.
    const source = terminalViewCode();
    expect(source).toMatch(/const createTab = \(\) => \{\s*try \{/u);
    expect(source).toContain('setNotice(error instanceof Error ? error.message : "A terminal tab could not be created.");');
  });
});

describe("terminal panel bar at phone width", () => {
  it("sheds the labels without shedding the glyph that stands in for them", () => {
    // `button span` also hid the `＋` of "New here", whose mark happens to live
    // in a span — an empty 44px box on every phone and in the workspace dock.
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toContain('.terminal-panel__bar button span:not([aria-hidden="true"]){display:none}');
    expect(css).not.toMatch(/\.terminal-panel__bar button span\{display:none\}/u);
  });
});

describe("the terminal panel's process controls", () => {
  /*
   * Restart and Close ran off the right edge of a 768px tablet with no
   * scrollbar, fade or chevron: the group was `flex:0 1 auto` over an
   * `overflow-x:auto` viewport, and the rescue that reversed it lived inside
   * `@media(max-width:760px)` — eight pixels short. The contract is that the
   * decision sits on the base rule, so no breakpoint can fall outside it.
   */
  it("never shrinks below the buttons, at any width", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const base = css.slice(0, css.indexOf("@media(max-width:760px)"));
    expect(base).toContain(".terminal-panel__bar>div:last-child{flex:0 0 auto;min-width:0}");
    expect(base).not.toMatch(/\.terminal-panel__bar>div:last-child\{[^}]*overflow-x:auto/u);
    // The shrink has to land on the state group instead, and land inside it:
    // a group that spills is the same clipped control by another route.
    expect(base).toContain(".terminal-panel__bar>div:first-child{min-width:0;overflow:hidden}");
  });
});

describe("the two rows this route's grid could crush without saying so", () => {
  const baseBlock = (): string => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    return css.slice(0, css.indexOf("@media(max-width:760px)"));
  };

  /*
   * The short-viewport block at the foot of the sheet names this mechanism for
   * 932×430. It is not a short-viewport mechanism.
   *
   * `.terminal-route__setup` and `.terminal-panel` both carried
   * `overflow:hidden` — and a grid item whose overflow is not `visible` has an
   * automatic minimum size of zero. So the route's own `min-height:min-content`
   * was computing a min-content that ignored 300px of its two largest rows: the
   * route never grew, and the shortfall was paid by shrinking those rows under
   * their content and painting the remainder nowhere. The panel needs its clip
   * — the rounded card, the popover anchored inside it — and its half of the
   * repair is arithmetic. The disclosure never needed one: nothing inside it
   * paints to its edge, so `hidden` was doing exactly one job there.
   *
   * Measured on the shipped build with the runtime disclosure open — a stored
   * preference, so it is the state a reader who opened it once gets on every
   * visit. At 1024×768 the setup showed 244px of 314 and the panel 236px of
   * 315, with the meta row's own box 77px BELOW the panel's bottom edge; at
   * 1440×900 the panel showed 290px of 315 and the meta row hung 23px past the
   * card. `overflow-y` computed `hidden` on both, so there was no scrollbar and
   * no fade — the row where the session reports what it is connected to was
   * neither visible nor reachable.
   */
  it("lets the disclosure's own row size to the disclosure", () => {
    const base = baseBlock();
    expect(base).toMatch(/\.terminal-route__setup\{overflow:visible/u);
    // The route grows to its rows and `main` carries the excess, the way it
    // carries every other long route in the app — but only once this row's
    // minimum is real, because `min-height:min-content` on the item is not
    // enough on its own: measured with `overflow:hidden` kept and that minimum
    // added, the item became 316px inside a 246px track and painted 59px of
    // itself over the tab strip. The clip has to stop being a clip.
    expect(base).toMatch(/\.terminal-route\{[^}]*min-height:min-content/u);
    expect(base).not.toMatch(/\.terminal-route__setup\{[^}]*overflow:hidden/u);
  });

  /*
   * And the row that has no such option. `overflow-x:auto` zeroes this item's
   * automatic minimum size on both axes — non-visible on either is enough — and
   * there is no version of a tab strip that scrolls horizontally without it. So
   * the minimum is written. With the disclosure's row restored and nothing
   * written here, the strip took the whole remaining shortfall at 1024×768 and
   * measured 2px: the same defect, one row lower.
   */
  it("writes the tab strip's minimum, because that row cannot infer one", () => {
    const base = baseBlock();
    expect(base).toContain(".terminal-tabs{display:flex;gap:5px;min-height:calc(var(--touch-target) + 2px);overflow-x:auto");
    // The floor is the touch decision the tab buttons already make plus the
    // strip's own 2px of padding, not a second opinion in literal pixels.
    expect(base).not.toMatch(/\.terminal-tabs\{[^}]*min-height:\d/u);
  });

  /*
   * The arithmetic underneath, and why the panel could not fit even when the
   * route handed it the whole floor it asked for. The route reserves
   * `minmax(14rem,1fr)` for the panel; the panel reserved `minmax(14rem,1fr)`
   * again for its emulator alone, and 224px of emulator plus a 44px bar, a 32px
   * meta row and 2px of borders is 302px inside a 224px reservation. One floor
   * for the terminal, written once: the emulator's own `min-height`. The panel
   * is then 44+144+32+2 = 222px at its smallest, inside the 224px the route was
   * already reserving.
   */
  it("counts the terminal's floor once, on the emulator, not twice", () => {
    const base = baseBlock();
    expect(base).toMatch(/\.terminal-panel\{[^}]*grid-template-rows:auto minmax\(0,1fr\) auto/u);
    expect(base).not.toMatch(/\.terminal-panel\{[^}]*minmax\(14rem/u);
    expect(base).toContain(".terminal-emulator{min-width:0;min-height:9rem;padding:10px;overflow:hidden}");
    // The route's own reservation for the whole card stays where it was: this
    // repair removes a double count, it does not buy the terminal less room.
    expect(base).toContain("grid-template-rows:auto auto auto minmax(14rem,1fr) auto");
  });

  /*
   * The dock shares all three of these rules and must not be harmed by them. It
   * is height-clamped in JavaScript against a measured parent, so the one thing
   * it cannot afford is a child that refuses to shrink: a `min-height:min-content`
   * on the panel would be exactly that. The three declarations this repair
   * makes are all safe for it — a row that sizes to its content, a 46px strip it
   * already renders, and a middle track floor that goes DOWN — and the dock's
   * own two-class rules outrank the unscoped ones where it disagrees.
   */
  it("leaves the workspace dock a panel that can still be told its size", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.terminal-panel\{[^}]*min-height:min-content/u);
    expect(css).toContain(".terminal-route--dock .terminal-panel{grid-template-rows:auto minmax(5rem,1fr) auto");
    expect(css).toContain(".terminal-route--dock .terminal-emulator{min-height:5rem");
  });
});

describe("the terminal panel's directory chip on a tablet row", () => {
  /*
   * The cost side of the rule above. Landing the whole shrink on the state
   * group landed all of it on the one field inside that group with
   * `min-width:0`: at 768 with four controls present the directory rendered as
   * a bare "/" in the workspace dock and "/…" in the route, while the
   * `= /workspace` mirror and the thread chip beside it kept full width. The
   * contract is that the path is floored and the two chips that identify least
   * per pixel are the ones that yield — and that neither the buttons nor the
   * mirror is paid for it, because those were the previous two repairs.
   */
  const tabletBand = (): string => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const start = css.indexOf("@media(min-width:761px) and (max-width:1024px){");
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("\n}", start));
  };

  it("floors the path and breaks the line before the chips beside it", () => {
    const band = tabletBand();
    // The basis decides where the flex line breaks — line filling reads
    // hypothetical sizes, so an `auto` basis would carry the whole path into
    // that decision — and the floor is what the path can never fall under.
    expect(band).toContain(".terminal-panel__bar code{flex:1 1 8rem;min-width:5rem}");
    expect(band).toMatch(/\.terminal-panel__bar>div:first-child\{[^}]*flex-wrap:wrap/u);
  });

  it("makes the thread chip the field that yields, on one line rather than three", () => {
    const band = tabletBand();
    expect(band).toContain(".terminal-panel__thread{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    // The rule needs a chip to select; the compact id is the only span in the
    // state group that was left unclassed.
    expect(terminalViewCode()).toContain('<span class="terminal-panel__thread" title={session.threadId}>thread {compactId(session.threadId)}</span>');
  });

  it("takes the room from neither the controls nor the mirror, which are the two repairs before this one", () => {
    const band = tabletBand();
    // Restart and Close ran off a 768px tablet; they are not the source of
    // this row's slack and nothing here may narrow, hide or unpin them.
    expect(band).not.toMatch(/div:last-child/u);
    expect(band).not.toMatch(/\.terminal-panel__bar button/u);
    // Dropping "= /workspace" is the phone's trade, taken on the phone's own
    // stated grounds. On a tablet the chip moves to a second line instead.
    expect(band).not.toMatch(/\.terminal-panel__mirror/u);
  });

  it("leaves the phone's own measured floor alone", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media(max-width:760px)"), css.indexOf("@media(min-width:761px)"));
    expect(phone).toContain(".terminal-panel__bar code{flex:1 1 auto;min-width:2.5rem}");
    expect(phone).toContain(".terminal-panel__mirror{display:none}");
  });
});

describe("the terminal route on a short viewport", () => {
  const shortBlock = () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    return css.slice(css.indexOf("@media(max-height:500px)"));
  };

  /*
   * 932×430 does not hold this route, and two passes spent themselves proving
   * it. Measured: `main` is 342px between a 44px topbar and a 44px navigation
   * band, `.route-layout` spends 14px and 20px of it, so the route is laid out
   * in 308px — against a 47px header, a 46px disclosure, a 46px tab strip, a
   * 44px status bar, a 37px meta row, a two-line 40px status sentence and the
   * gaps between them. Nominating the emulator as the row that yields ended
   * where it had to: a 45px emulator box, 33px of content inside its gutter,
   * and a 22px cell — ONE row of shell output.
   *
   * So the rows are allowed to be taller than the port and the reader scrolls
   * to the rest of them. This is the assertion that keeps a future height budget
   * from being balanced against the terminal again.
   */
  it("lets the rows outgrow a viewport that cannot hold them instead of slicing its own content", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const short = shortBlock();
    expect(short).toContain("gap:4px;height:100%;min-height:0;overflow:auto}");
    // The base route's `min-height:min-content` is the declaration that inflates
    // the box to its rows; retracting it here is what keeps the box the port.
    expect(css).toMatch(/\.terminal-route\{[^}]*height:100%;min-height:min-content/u);
    // The dock declares its own rows and is clamped against a measured parent;
    // an unscoped `.terminal-route` here would impose a fifth row on its four.
    expect(short).not.toMatch(/\n\s*\.terminal-route\{/u);
  });

  /*
   * The regression this pins, and the reason the previous line reads
   * `height:100%` rather than `height:auto`.
   *
   * The pass that made this route scroll wrote `height:auto` with
   * `min-height:100%`, on the reasoning that `main` has always had
   * `overflow:auto` and would carry the excess. It did not. Measured on the
   * shipped build at 932×430: `documentElement.scrollHeight - clientHeight`
   * read 95 where all seven other device classes read 0 and where this one read
   * 0 before that pass; the full-page frame came back 525px against a 430px
   * viewport; and scrolling to the foot of the document moved the whole shell,
   * leaving the 44px navigation band over ~90px of bare `--ground` with the
   * panel's meta row and the `role="status"` footer stranded below it.
   *
   * A route may be taller than its port. Its BOX may not: the moment this grid
   * is allowed to inflate to the height of its own rows, the excess leaves
   * `main` and the shell scrolls with it. `height:100%` pins the box, and
   * `overflow:auto` is what then carries the rows — the two only work as a pair,
   * because `overflow:auto` on an auto-height box has nothing to scroll and
   * `height:100%` without it clips the rows outright.
   */
  it("scrolls its own rows rather than the shell the navigation band stands on", () => {
    const short = shortBlock();
    const route = short.match(/\.terminal-route:not\(\.terminal-route--dock\)\{([^}]+)\}/u)?.[1] ?? "";
    expect(route).toContain("overflow:auto");
    expect(route).toContain("height:100%");
    // `height:auto` is the exact declaration that put the excess on the
    // document; `min-height:min-content` and `min-height:100%` reach the same
    // inflated box by the other door.
    expect(route).not.toMatch(/height:auto/u);
    expect(route).not.toMatch(/min-height:(?:min-content|100%)/u);
  });

  /*
   * What the scroll buys. `16rem` makes the panel 256px: a 44px bar, a 173px
   * emulator box and a 32px meta row inside two borders, so the emulator's
   * content box is 161px — seven 22px rows where there was one. The panel plus
   * the 40px status line and their gap is 300px, so both still fit the 308px
   * viewport once the chrome above has scrolled away, which is the property
   * that makes the scroll worth taking rather than merely honest.
   */
  it("gives the emulator a terminal's worth of rows at the one viewport that had none", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const short = shortBlock();
    expect(short).toContain(".terminal-route:not(.terminal-route--dock){grid-template-rows:auto auto auto minmax(16rem,1fr) auto");
    // The panel's own 14rem floor wanted 307px inside that 256px box and
    // `overflow:hidden` answered by swallowing the meta row, so the middle track
    // yields and the bar and meta row take what they need first. That reading
    // was right and it was never local: the same double-counted 14rem swallowed
    // the meta row at 1024×768 and 1440×900. The base rule states it once now,
    // and restating it here would be a second opinion about the same number.
    expect(short).not.toMatch(/\.terminal-panel\{grid-template-rows/u);
    expect(css).toMatch(/\.terminal-panel\{[^}]*grid-template-rows:auto minmax\(0,1fr\) auto/u);
    // The gutter is the phone's 6px, and it is now the only thing the emulator
    // rule says: at a 22px cell the 8px saved against the base 10px is most of
    // a row, so it is spent on output. The 2.5rem squeeze that used to stand
    // here was the one-row terminal, stated as a floor.
    expect(short).toContain(".terminal-emulator{padding:6px}");
    expect(short).not.toMatch(/\.terminal-emulator\{[^}]*min-height/u);
  });

  /*
   * `.terminal-route__setup` and `.terminal-tabs` were the only two rows in this
   * grid whose automatic minimum size was zero — both carried non-visible
   * overflow — so they were the rows that absorb a shortfall in silence rather
   * than overflowing where a reader can see it, which is how they became a 2px
   * stripe. They are no longer squeezed, and what keeps that true if the route
   * is ever height-clamped again is now written at the base: the strip's floor
   * unqualified by viewport height, and the disclosure's `overflow:visible`.
   */
  it("leaves the two rows floored by the base rather than by this block", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const short = shortBlock();
    // The floors moved one width up rather than away. Neither was ever a
    // short-viewport property, and `calc(var(--touch-target) + 2px)` was the
    // right floor for a CLOSED summary and the wrong one for an open
    // disclosure — whose open state is a stored preference. Measured here at
    // 932×430 with the runtime band open, the setup held 333px of content in
    // the 44px its floor bought it: the block written to end a 2px stripe left
    // a 44px one. The base rules answer both, the tab strip with the same
    // number and the disclosure by no longer clipping at all.
    expect(short).not.toMatch(/min-height:calc/u);
    expect(css.slice(0, css.indexOf("@media(max-width:760px)")))
      .toContain(".terminal-tabs{display:flex;gap:5px;min-height:calc(var(--touch-target) + 2px);overflow-x:auto");
    expect(short).toContain(".terminal-route:not(.terminal-route--dock)>.terminal-route__header{margin-bottom:0}");
  });

  /*
   * The floors this block exists to protect. A repair that balanced by shaving
   * one of them would be the trade this whole wave exists to stop — the
   * shortfall would simply move to whichever control was cheapest to cut, which
   * is how the emulator's 14rem floor crushed the disclosure in the first
   * place, and how the emulator itself ended at one row.
   */
  it("balances the budget without narrowing a control or shrinking a touch target", () => {
    const short = shortBlock();
    // The 44px bar and the 32px meta row are a touch target and a fact; the
    // panel's height comes off its middle row or it does not come off at all.
    expect(short).not.toMatch(/\.terminal-panel__bar/u);
    expect(short).not.toMatch(/\.terminal-panel__meta/u);
    // The status line is a live region. Clamping, ellipsising or pinning it
    // would answer the overflow by deleting the sentence instead.
    expect(short).not.toMatch(/\.terminal-route__footer\{/u);
    // Nothing here touches the inline axis: this is a short viewport, not a
    // narrow one, and the emulator's gutter is the one padding that changes.
    expect(short).not.toMatch(/width|flex|display:none/u);
  });

  /*
   * Neither unscoped declaration in this block may reach the Workspace dock,
   * which is height-clamped in JavaScript against its measured parent and would
   * be handed a 256px panel it has no room for. Nothing in the media query says
   * so; the two-class dock rules outrank the one-class rules on specificity,
   * which is only true while the dock keeps declaring both of them.
   */
  it("leaves the dock's own smaller floors outranking the two unscoped rules", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toContain(".terminal-route--dock .terminal-panel{grid-template-rows:auto minmax(5rem,1fr) auto");
    expect(css).toMatch(/\.terminal-route--dock \.terminal-emulator\{[^}]*padding:6px 8px/u);
  });
});

describe("the terminal body boundary", () => {
  it("clips xterm paint to its grid cell instead of the panel's next row", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.terminal-emulator\{[^}]*overflow:hidden/u);
  });

  /*
   * `xterm.css` hardcodes `background-color:#000` on the viewport, and no
   * `theme` option reaches it: `theme.background` goes to the renderer, which
   * paints the canvas over the rows it has, and the viewport is what shows
   * wherever the canvas does not. Measured at 932×430 on `11-tab-keyboard-focus`
   * — a hard `#000000` block filling the emulator's whole content box against
   * the panel's `#0b0e0f` around it, because a tab opened into a one-row box
   * had no canvas painted yet. The colour has to be restated in this sheet or
   * it cannot be reached at all, and it has to be the panel's own or the card
   * stops being one surface.
   */
  it("gives xterm's viewport the card's colour, because its own stylesheet hardcodes black", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const panel = css.match(/\n\.terminal-panel\{([^}]+)\}/u)?.[1] ?? "";
    const viewport = css.match(/\.terminal-emulator \.xterm-viewport\{([^}]+)\}/u)?.[1] ?? "";

    expect(panel).toContain("background:#0b0e0f");
    expect(viewport).toContain("background-color:#0b0e0f");
    // The scrollbar track was already told the same colour; the surface behind
    // it was the half that was never said.
    expect(viewport).toContain("scrollbar-color:#515b5f #0b0e0f");
  });

  /*
   * And the emulator's own theme still names that colour to the renderer, so
   * the canvas and the viewport under it agree. Asserted against the source
   * because a theme that drifted from the stylesheet would show up exactly
   * where the bug above did: at the edges the canvas does not cover.
   */
  it("hands the renderer the same background the stylesheet paints behind it", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/theme:\s*\{\s*background:\s*"#0b0e0f"/u);
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

    /*
     * The same floor on the closed bar, for the two touch devices that report a
     * wider viewport than the phone block covers — a 932x430 landscape phone
     * and a 768x1024 tablet — where 34px controls sat inside a 42px bar. It is
     * load-bearing now rather than cosmetic: a panel too short to hold a
     * terminal renders this bar and nothing else, so on a landscape phone these
     * two buttons are the entire dock.
     */
    const dockCoarse = dock.slice(dock.indexOf("@media (pointer: coarse)"));
    expect(dockCoarse).toContain(".workspace-terminal-dock[data-open=false], .workspace-terminal-dock__collapsed { height: 48px; }");
    expect(dockCoarse).toMatch(/\.workspace-terminal-dock__collapsed button \{\s*min-width: var\(--touch-target\);\s*min-height: var\(--touch-target\);/u);
  });
});

/*
 * The process card's status row, and which of its fields pays for a narrow one.
 */
describe("the dock's process row", () => {
  it("truncates the thread id rather than tower it through the card's own divider", () => {
    const route = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const routePhone = route.slice(route.indexOf("@media(max-width:760px)"), route.indexOf("@media(min-width:761px)"));
    expect(routePhone).toContain(".terminal-route--dock .terminal-panel__thread{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    /*
     * Scoped to the dock, and asserted as scoped. The full route reaches the
     * same row through the same markup and is a separate surface with a
     * separate scroll model — it scrolls its own box below 500px of height,
     * where the dock is height-bound inside the workbench panel — so the two
     * are not one decision and an unscoped rule here would make them one.
     */
    expect(routePhone).not.toMatch(/^\s*\.terminal-panel__thread\{/mu);
  });
});

describe("the terminal's one Git command surface", () => {
  it("has no second form competing with the PTY", () => {
    const source = terminalViewCode();
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(source).not.toContain('<form class="terminal-git"');
    expect(source).not.toContain("terminal-git-command");
    expect(css).not.toContain(".terminal-git{");
  });
});

describe("the tab rename affordance on touch surfaces", () => {
  /*
   * 34px wide, no height, and invisible until hover: the rename control had
   * no reachable path on a device that cannot hover.
   *
   * This used to assert a split — the phone block lifts it to 44px, the coarse
   * block keeps it painted — and the split was the defect. Paint and size are
   * one question ("is a finger doing the pointing"), and answering them on two
   * different queries meant every coarse pointer outside the phone width got
   * one answer and not the other: measured on the built tree, a tablet at
   * 768x1024 and a landscape phone at 932x430 both rendered this control
   * *visible* and 34x44 — floored on the axis it never needed, 10px under on
   * the axis it did, and the previous version of this test read that as a pass
   * because both strings it looked for were present.
   *
   * So the width floor now lives on the pointer query beside the paint, and
   * this asserts that rather than the split. The phone block keeps its own
   * copy: a narrow *desktop* window is a fine pointer, so `pointer: coarse` is
   * false there and the width rule still has work to do.
   */
  it("floors and paints the rename control on the same coarse-pointer query", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media(max-width:760px)"));
    expect(phone).toContain(".terminal-tab .terminal-tab__rename{min-width:var(--touch-target);min-height:var(--touch-target);opacity:1}");
    // Width and paint together — the floor may not be left behind on a width.
    expect(css).toContain("@media(pointer:coarse){.terminal-tab .terminal-tab__rename{min-width:var(--touch-target);opacity:1}}");
    // The height floor reaches it from `.terminal-route button`, so a coarse
    // pointer has both axes; asserted here so removing that rule fails loudly.
    expect(css).toMatch(/^\.terminal-route button\{[^}]*min-height:var\(--touch-target\)/mu);
  });

  /*
   * The panel bar's process controls, on the same argument. `New here`,
   * `Restart`, `Close` and the `running`-only `Interrupt` measured 36px tall at
   * both coarse viewports above, because their 44px lived in the phone block
   * only. The floor moves to the pointer; the label-shedding in the phone block
   * deliberately does not, since dropping these buttons to bare glyphs is a
   * 320px space decision and not a touch decision.
   */
  it("floors the panel bar's process controls on the pointer, without shedding their labels", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toContain("@media(pointer:coarse){.terminal-panel__bar button{min-height:var(--touch-target)}}");
    const coarse = css.slice(css.indexOf("@media(pointer:coarse){.terminal-panel__bar"));
    expect(coarse.slice(0, 200)).not.toContain("span:not([aria-hidden");
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

  it("hands submitted terminal intent the active approval policy rather than the bridge's optional default", () => {
    // The comment that stood on these props — "Retained for app compatibility"
    // — was the audit trail of the deletion: two threaded props, no consumer.
    // The rule it also carried (bridge output never enters PTY scrollback) is
    // still true and still stated; the compatibility excuse is gone.
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("Retained for app compatibility");
    expect(source).toMatch(/runTerminalGitBridge\(\{[\s\S]*command: gitIntent\.command,[\s\S]*cwd: gitIntent\.cwd,[\s\S]*client: git,[\s\S]*review: reviewGit,/u);
  });

  it("claims and records the same intent through the manager-owned lineage", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).toContain("manager.pendingBrowserGitIntent(profileId)");
    expect(source).toContain("manager.claimBrowserGitIntent(gitIntent)");
    expect(source).toContain("manager.recordBrowserGitResult(gitIntent, outcome)");
  });
});

describe("the Terminal transcript's Browser Git bridge", () => {
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
    expect(terminalGitNotice(outcome)).toContain("Airship Browser Git refused git add -A at /workspace");
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

  it("states why Git is sideband instead of claiming the WebContainer owns it", () => {
    expect(TERMINAL_GIT_BOUNDARY_NOTICE).toContain("jsh has no git binary");
    expect(TERMINAL_GIT_BOUNDARY_NOTICE).toContain("BrowserGitClient");
    expect(source).toContain("{TERMINAL_GIT_BOUNDARY_NOTICE}");
  });
});

/*
 * `git status` is the likeliest first command on this route, and jsh answered
 * it with "jsh: command not found: git" while the bridge that can answer it sat
 * 200px below with `git status` as its placeholder. The refusal is a seam now.
 */
describe("a git line submitted to jsh", () => {
  it("routes automatically without a second field or a dock-only detour", () => {
    const source = readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8");
    expect(source).toContain("const gitIntent = manager.pendingBrowserGitIntent(profileId)");
    expect(source).toContain("Routing ${gitIntent.command} through Airship Browser Git");
    expect(source).not.toContain("Open Browser Git");
    expect(source).not.toContain("Run it here");
  });
});

describe("the drift a sync button used to ask the reader to guess at", () => {
  const record = (kind: "interactive-input" | "workspace-reconcile" | "browser-git", recordedAt: string, sourceRecordId?: string) => ({
    id: `${kind}-${recordedAt}`, sequence: 1, kind, outcome: "completed" as const, recordedAt, processEpoch: 1, summary: kind,
    ...(sourceRecordId ? { sourceRecordId } : {}),
  });
  const session = (audit: readonly ReturnType<typeof record>[]) => ({ audit } as never);

  it("counts only the lines no reconciliation has followed", () => {
    // Measured: `echo 'from the terminal' > from-terminal.txt` left Explorer at
    // three files with nothing on screen saying the two copies had diverged.
    expect(terminalUnreconciledInputs([session([
      record("interactive-input", "2026-07-31T10:00:00.000Z"),
      record("workspace-reconcile", "2026-07-31T10:00:01.000Z"),
      record("interactive-input", "2026-07-31T10:00:02.000Z"),
      record("interactive-input", "2026-07-31T10:00:03.000Z"),
    ])])).toBe(2);
  });

  it("is zero the moment a reconciliation lands, across every tab", () => {
    expect(terminalUnreconciledInputs([
      session([record("interactive-input", "2026-07-31T10:00:00.000Z")]),
      session([record("workspace-reconcile", "2026-07-31T10:00:05.000Z")]),
    ])).toBe(0);
  });

  it("counts everything before the first reconciliation, because the mount was never pushed back", () => {
    expect(terminalUnreconciledInputs([session([
      record("interactive-input", "2026-07-31T10:00:00.000Z"),
      record("interactive-input", "2026-07-31T10:00:01.000Z"),
    ])])).toBe(2);
  });

  it("does not call an Airship Browser Git answer unreconciled shell work", () => {
    const input = record("interactive-input", "2026-07-31T10:00:00.000Z");
    expect(terminalUnreconciledInputs([session([
      input,
      record("browser-git", "2026-07-31T10:00:01.000Z", input.id),
    ])])).toBe(0);
  });
});

describe("who owns the keyboard inside a terminal", () => {
  it("names the chords that stop firing and the key that leaves", () => {
    // Measured: after clicking the xterm, `g` then `s` left the hash at
    // `#terminal`, and no text anywhere on the route mentioned focus.
    expect(TERMINAL_KEYBOARD_OWNERSHIP).toContain("g-chords do not fire");
    expect(TERMINAL_KEYBOARD_OWNERSHIP).toContain("Shift+Tab");
  });
});
