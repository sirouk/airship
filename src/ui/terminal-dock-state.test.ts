import { describe, expect, it } from "vitest";
import {
  TERMINAL_DOCK_DEFAULT_HEIGHT,
  TERMINAL_DOCK_EDITOR_FLOOR,
  TERMINAL_DOCK_FLOOR_HEIGHT,
  TERMINAL_DOCK_MIN_HEIGHT,
  readTerminalDockState,
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
   * The landscape phone this clamp was losing. Measured on the shipped build at
   * 932x430: `.editor-route__panel` is 327px, the workbench above the dock needs
   * 150px for its document tab strip and its file strip, and the dock was
   * returning 220px regardless — 107px for 150px of chrome, so the theme picker,
   * Keep open, Wrap and Save were cut in half by the dock's top edge with
   * nothing on the route scrolling to reach them.
   */
  it("gives up the dock's opening height before it buries the controls above it", () => {
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, 327)).toBe(327 - TERMINAL_DOCK_EDITOR_FLOOR);
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, 327)).toBeLessThan(TERMINAL_DOCK_MIN_HEIGHT);
    // 320x568 with the dock open: a 322px panel, where the same trade hands the
    // file tree its first row back instead of leaving the rail nothing but its
    // search field.
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, 322)).toBe(322 - TERMINAL_DOCK_EDITOR_FLOOR);
    // And it is a trade with a bottom: the dock keeps its own toolbar, session
    // strip and session header whatever the panel does.
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, 180)).toBe(TERMINAL_DOCK_FLOOR_HEIGHT);
    expect(terminalDockMaximum(120)).toBe(TERMINAL_DOCK_FLOOR_HEIGHT);
    // The dock's floor may never be the term that binds at a viewport this
    // product ships to: at 932x430 only 295px of the 327px panel is on screen,
    // and a floor tall enough to be chosen there would re-slice the editor's
    // controls the day that 32px is given back.
    expect(TERMINAL_DOCK_FLOOR_HEIGHT).toBeLessThanOrEqual(295 - TERMINAL_DOCK_EDITOR_FLOOR);
  });

  it("leaves every panel that can afford both surfaces exactly as it was", () => {
    // The clamp binds only below MIN + FLOOR. Measured panels at phone-390,
    // phone-430, tablet-768, laptop-1024, desktop-1440 and wide-1920 are all
    // above it, so the dock still opens at its stored height there.
    const roomy = TERMINAL_DOCK_MIN_HEIGHT + TERMINAL_DOCK_EDITOR_FLOOR;
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, 607)).toBe(TERMINAL_DOCK_DEFAULT_HEIGHT);
    expect(terminalDockHeight(TERMINAL_DOCK_DEFAULT_HEIGHT, roomy)).toBe(TERMINAL_DOCK_MIN_HEIGHT);
    expect(terminalDockMinimum(607)).toBe(TERMINAL_DOCK_MIN_HEIGHT);
  });

  /*
   * The resize separator states a range, and a range whose minimum is above its
   * maximum is a lie told to the one reader who cannot see the split.
   */
  it("never reports a minimum above the maximum on a panel too small for both", () => {
    for (const available of [120, 180, 322, 327, 400, 900]) {
      expect(terminalDockMinimum(available)).toBeLessThanOrEqual(terminalDockMaximum(available));
    }
  });

  it("rejects empty or control-character scope identifiers", () => {
    expect(() => terminalDockStorageKey("", "profile-a")).toThrow(/Workspace identity/u);
    expect(() => terminalDockStorageKey("workspace-a", "profile\nunsafe")).toThrow(/Profile ID/u);
  });
});
