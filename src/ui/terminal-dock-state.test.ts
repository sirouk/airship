import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TERMINAL_DOCK_DEFAULT_HEIGHT,
  TERMINAL_DOCK_EDITOR_FLOOR,
  TERMINAL_DOCK_MIN_HEIGHT,
  TERMINAL_DOCK_OPEN_HEIGHT,
  readTerminalDockState,
  terminalDockFitsPanel,
  terminalDockHeight,
  terminalDockMaximum,
  terminalDockMinimum,
  terminalDockStorageKey,
  terminalOpenRequestForAuthority,
  updateTerminalDockState,
} from "./terminal-dock-state";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("profile-scoped Workspace terminal dock state", () => {
  it("admits an async CWD request only to the exact Profile and workspace that issued it", () => {
    const request = Object.freeze({
      id: "request-1",
      cwd: "/workspace/docs",
      profileId: "profile-alpha",
      workspaceIdentity: "workspace-alpha",
    });
    expect(terminalOpenRequestForAuthority(request, "workspace-alpha", "profile-alpha")).toBe(request);
    expect(terminalOpenRequestForAuthority(request, "workspace-alpha", "profile-beta")).toBeUndefined();
    expect(terminalOpenRequestForAuthority(request, "workspace-beta", "profile-alpha")).toBeUndefined();
    expect(terminalOpenRequestForAuthority(undefined, "workspace-alpha", "profile-alpha")).toBeUndefined();
  });

  it("isolates layout and selected terminal by workspace and profile", () => {
    const storage = memoryStorage();
    updateTerminalDockState(storage, "workspace-a", "profile-a", { open: true, height: 410, selectedSessionId: "terminal-alpha" });
    updateTerminalDockState(storage, "workspace-a", "profile-b", { open: false, height: 260, selectedSessionId: "terminal-beta" });

    expect(terminalDockStorageKey("workspace-a", "profile-a")).not.toBe(terminalDockStorageKey("workspace-a", "profile-b"));
    expect(terminalDockStorageKey("workspace-a", "profile-a")).not.toBe(terminalDockStorageKey("workspace-b", "profile-a"));
    expect(readTerminalDockState(storage, "workspace-a", "profile-a")).toEqual({ open: true, height: 410, selectedSessionId: "terminal-alpha" });
    expect(readTerminalDockState(storage, "workspace-a", "profile-b")).toEqual({ open: false, height: 260, selectedSessionId: "terminal-beta" });
  });

  it("merges selection updates without erasing open and resized state", () => {
    const storage = memoryStorage();
    updateTerminalDockState(storage, "workspace-a", "profile-a", { open: true, height: 444 });
    updateTerminalDockState(storage, "workspace-a", "profile-a", { selectedSessionId: "terminal-2" });
    expect(readTerminalDockState(storage, "workspace-a", "profile-a")).toEqual({ open: true, height: 444, selectedSessionId: "terminal-2" });
  });

  it("keeps a dock taller than the fallback when a selection update arrives with no measured height", () => {
    const storage = memoryStorage();
    // Seeded with a measured parent, so the 900px height is stored verbatim —
    // above the 720px unseen-viewport fallback.
    updateTerminalDockState(storage, "workspace-a", "profile-a", { open: true, height: 900 }, 1_400);
    // The terminal route persists every tab selection with no height argument;
    // that round-trip used to clamp the dock back to 720px without any resize.
    const next = updateTerminalDockState(storage, "workspace-a", "profile-a", { selectedSessionId: "terminal-1" });
    expect(next).toEqual({ open: true, height: 900, selectedSessionId: "terminal-1" });
    expect(readTerminalDockState(storage, "workspace-a", "profile-a").height).toBe(900);
    // A measured parent still clamps the stored height to real editor room on read.
    expect(readTerminalDockState(storage, "workspace-a", "profile-a", 600).height).toBe(600 - TERMINAL_DOCK_EDITOR_FLOOR);
  });

  it("fails closed on missing or malformed state and clamps to available editor room", () => {
    expect(readTerminalDockState(undefined, "workspace-a", "profile-a")).toEqual({ open: false, height: TERMINAL_DOCK_DEFAULT_HEIGHT });
    expect(readTerminalDockState({ getItem: () => "{" }, "workspace-a", "profile-a")).toEqual({ open: false, height: TERMINAL_DOCK_DEFAULT_HEIGHT });
    expect(terminalDockHeight(-100, 600)).toBe(TERMINAL_DOCK_MIN_HEIGHT);
    expect(terminalDockHeight(900, 600)).toBe(600 - TERMINAL_DOCK_EDITOR_FLOOR);
  });

  /*
   * The landscape phone, and what the clamp written for it gave back.
   *
   * Ranking the editor's floor above the dock's opening height was right and is
   * asserted below: at 932x430 `.editor-route__panel` is 327px, the workbench
   * needs 150px for its document tab strip and its file strip, and returning
   * 220px left it 107px with `.workbench-shell`'s `overflow: hidden` slicing the
   * theme picker, Keep open, Wrap and Save through the middle.
   *
   * What was wrong was the floor underneath it — 136px, the dock's own controls
   * and not a pixel more — because a dock the exact height of its own controls
   * has no output area by construction. Measured on the shipped build, the dock
   * came out at 171px at 932x430 and 175px at 320x568 against 246px of phone
   * chrome: a 17px transcript and an 8px one, a session strip crushed to
   * nothing, and a process card whose bottom border was off the screen.
   */
  it("does not hand back a dock too short to hold a terminal", () => {
    expect(terminalDockFitsPanel(327)).toBe(false);
    expect(terminalDockFitsPanel(322)).toBe(false);
    // What those panels could afford, against the 246px the dock's frame costs
    // on a phone before one character of transcript.
    for (const panel of [322, 327]) {
      expect(panel - TERMINAL_DOCK_EDITOR_FLOOR).toBeLessThan(246);
    }
    // And the number the gate is written from is that frame plus one 22px row
    // inside its 12px gutter, not a round figure chosen to make the two fail.
    expect(TERMINAL_DOCK_OPEN_HEIGHT).toBe(246 + 22 + 12);
  });

  it("leaves every panel that can afford both surfaces exactly as it was", () => {
    // The gate binds only below OPEN + EDITOR_FLOOR, which is 436px of panel.
    // The six measured panels that host a dock today — phone-390, phone-430,
    // tablet-768, laptop-1024, desktop-1440 and wide-1920 — are 653px and
    // taller, so the dock still opens at its stored height there and nothing
    // moves.
    const roomy = TERMINAL_DOCK_OPEN_HEIGHT + TERMINAL_DOCK_EDITOR_FLOOR;
    expect(roomy).toBe(436);
    expect(terminalDockFitsPanel(roomy)).toBe(true);
    expect(terminalDockFitsPanel(roomy - 1)).toBe(false);
    expect(terminalDockFitsPanel(653)).toBe(true);
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, 607)).toBe(TERMINAL_DOCK_DEFAULT_HEIGHT);
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, roomy)).toBe(TERMINAL_DOCK_OPEN_HEIGHT);
    // The separator's own floor is unchanged: a reader may still drag their
    // dock down to 220, which is a thing they did on purpose and can undo.
    expect(terminalDockMinimum()).toBe(TERMINAL_DOCK_MIN_HEIGHT);
    expect(TERMINAL_DOCK_MIN_HEIGHT).toBeLessThan(TERMINAL_DOCK_OPEN_HEIGHT);
  });

  /*
   * An unmeasured parent is not a short one. The dock renders before its
   * persisted state resolves and before the resize observer has said anything,
   * and closing it there would flash the reader's own terminal away.
   */
  it("believes the reader when there is no panel to measure", () => {
    expect(terminalDockFitsPanel(undefined)).toBe(true);
    expect(terminalDockFitsPanel(Number.NaN)).toBe(true);
  });

  /*
   * The resize separator states a range, and a range whose minimum is above its
   * maximum is a lie told to the one reader who cannot see the split. It used
   * to need a second clamp to stay true; it is now true by construction,
   * because every panel that renders a separator at all is one whose maximum is
   * at least the dock's minimum.
   */
  it("never reports a minimum above the maximum on any panel that renders one", () => {
    for (const available of [120, 180, 322, 327, 400, 900]) {
      expect(terminalDockMinimum()).toBeLessThanOrEqual(terminalDockMaximum(available));
    }
  });

  it("rejects empty or control-character scope identifiers", () => {
    expect(() => terminalDockStorageKey("", "profile-a")).toThrow(/Workspace identity/u);
    expect(() => terminalDockStorageKey("workspace-a", "profile\nunsafe")).toThrow(/Profile ID/u);
  });
});

/*
 * The fitness test decides nothing on its own — it is the render that has to
 * act on it, and the render is where the previous shape of this repair went
 * wrong: the clamp returned a smaller number and the dock drew a terminal in it
 * regardless.
 */
describe("the dock a panel cannot hold", () => {
  const source = readFileSync(new URL("./workspace-terminal-dock.tsx", import.meta.url), "utf8");

  it("draws its closed bar rather than a terminal with nowhere to print", () => {
    // The observed panel, not the `innerHeight` fallback a clamp may guess from.
    expect(source).toContain("const open = state.open && terminalDockFitsPanel(panelHeight);");
    expect(source).toContain('data-open={open ? "true" : "false"}');
    // Every branch that renders terminal chrome hangs off the gate, including
    // the dynamic import: a dock that will draw its closed bar has no use for
    // the terminal chunk.
    expect(source).toContain("if (!open || TerminalSurface || loadError) return;");
    expect(source).toContain("{open ? TerminalSurface ? <TerminalSurface");
  });

  it("keeps the reader's request across the rotation that cannot honour it", () => {
    // `commit({ open: false })` here would spend the reader's intent on a
    // viewport change, so an upright phone would come back to a closed dock.
    const noRoom = source.slice(source.indexOf('data-reason="no-room"'), source.indexOf('<div class="workspace-terminal-dock__collapsed">'));
    // On the field that survives the phone block's `small { display: none }`.
    expect(noRoom).toContain("<span>No room for output — open full view</span>");
    // The wide control leads with the surface that does have the room; "expand"
    // would be a button that cannot do what it says.
    expect(noRoom).toContain("<button type=\"button\" onClick={props.onOpenFullView}>");
    expect(noRoom).not.toContain("commit({ open: true })");
    // And Collapse stays, so the dock can be put away rather than reappearing.
    expect(noRoom).toContain('aria-label="Collapse terminal dock"');
  });
});
