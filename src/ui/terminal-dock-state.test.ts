import { describe, expect, it } from "vitest";
import {
  TERMINAL_DOCK_DEFAULT_HEIGHT,
  TERMINAL_DOCK_EDITOR_FLOOR,
  TERMINAL_DOCK_MIN_HEIGHT,
  readTerminalDockState,
  terminalDockHeight,
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

  it("rejects empty or control-character scope identifiers", () => {
    expect(() => terminalDockStorageKey("", "profile-a")).toThrow(/Workspace identity/u);
    expect(() => terminalDockStorageKey("workspace-a", "profile\nunsafe")).toThrow(/Profile ID/u);
  });
});
