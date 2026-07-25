import { describe, expect, it } from "vitest";
import {
  CANONICAL_DESTINATIONS,
  MOBILE_MORE_ENTRIES,
  MOBILE_PRIMARY_CONTROLS,
  SETTINGS_OVERLAY_ENTRY,
  canonicalParentForView,
  mobilePrimaryControlForView,
  navigationHashForView,
  navigationViewFromHash,
  type NavigationView,
} from "./navigation-model";

const allViews: readonly NavigationView[] = [
  "chat",
  "sessions",
  "workspace",
  "editor",
  "terminal",
  "memory",
  "context",
  "profiles",
  "capabilities",
  "skills",
  "vault",
  "billing",
  "proof",
  "access",
];

describe("canonical navigation model", () => {
  it("models conversation and workspace subroutes under their canonical parents", () => {
    expect(CANONICAL_DESTINATIONS.map((entry) => entry.id)).toEqual([
      "chat",
      "workspace",
      "memory",
      "profiles",
      "proof",
      "vault",
      "access",
    ]);
    expect(CANONICAL_DESTINATIONS).toHaveLength(7);

    const chat = CANONICAL_DESTINATIONS.find((entry) => entry.id === "chat");
    const workspace = CANONICAL_DESTINATIONS.find((entry) => entry.id === "workspace");
    const profiles = CANONICAL_DESTINATIONS.find((entry) => entry.id === "profiles");
    const connection = CANONICAL_DESTINATIONS.find((entry) => entry.id === "access");
    expect(chat?.nested).toEqual([
      expect.objectContaining({ id: "sessions", label: "All conversations", hash: "#sessions" }),
    ]);
    expect(workspace?.nested).toEqual([
      expect.objectContaining({ id: "editor", label: "Editor", hash: "#editor" }),
      expect.objectContaining({ id: "terminal", label: "Terminal", hash: "#terminal" }),
    ]);
    expect(profiles?.nested).toEqual([]);
    expect(connection?.nested).toEqual([
      expect.objectContaining({ id: "billing", label: "Account", hash: "#account" }),
    ]);
    expect(canonicalParentForView("skills")).toBe("profiles");
    expect(canonicalParentForView("capabilities")).toBe("profiles");
    expect(canonicalParentForView("billing")).toBe("access");
    expect(canonicalParentForView("sessions")).toBe("chat");
    expect(canonicalParentForView("editor")).toBe("workspace");
    expect(canonicalParentForView("terminal")).toBe("workspace");
    expect(canonicalParentForView("context")).toBe("memory");
  });

  it("emits label-aligned hashes and preserves legacy route aliases", () => {
    for (const view of allViews) {
      const expectedHash = view === "access" ? "#connection" : view === "billing" ? "#account" : `#${view}`;
      expect(navigationHashForView(view)).toBe(expectedHash);
      expect(navigationViewFromHash(expectedHash)).toBe(view);
      expect(navigationViewFromHash(`${expectedHash}?selection=current`)).toBe(view);
    }
    expect(navigationViewFromHash("#access")).toBe("access");
    expect(navigationViewFromHash("#billing")).toBe("billing");
    expect(navigationViewFromHash("#sources")).toBe("editor");
    expect(navigationViewFromHash("#attestations")).toBe("proof");
    expect(navigationViewFromHash("#unknown")).toBe("chat");
  });

  it("defines four fixed mobile controls with conversations available through More", () => {
    expect(MOBILE_PRIMARY_CONTROLS).toEqual([
      { id: "chat", label: "Chat", kind: "route", view: "chat" },
      { id: "workspace", label: "Workspace", kind: "route", view: "workspace" },
      { id: "trust", label: "Trust", kind: "route", view: "proof" },
      { id: "more", label: "More", kind: "overlay", overlay: "more" },
    ]);
    expect(MOBILE_PRIMARY_CONTROLS).toHaveLength(4);
    expect(mobilePrimaryControlForView("proof")).toBe("trust");
  });

  it("keeps nested destinations attached to their primary mobile parent", () => {
    expect(Object.fromEntries(allViews.map((view) => [view, mobilePrimaryControlForView(view)]))).toEqual({
      chat: "chat",
      sessions: "chat",
      workspace: "workspace",
      editor: "workspace",
      terminal: "workspace",
      memory: "more",
      context: "more",
      profiles: "more",
      capabilities: "more",
      skills: "more",
      vault: "trust",
      billing: "trust",
      proof: "trust",
      access: "trust",
    });
  });

  it("provides the complete More sheet order and a distinct Settings overlay", () => {
    expect(MOBILE_MORE_ENTRIES.map((entry) => entry.id)).toEqual([
      "sessions",
      "editor",
      "terminal",
      "memory",
      "profiles",
      "vault",
      "access",
      "billing",
      "settings",
    ]);
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "skills")).toBeUndefined();
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "capabilities")).toBeUndefined();
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "billing")).toEqual(
      expect.objectContaining({ parent: "access", label: "Account", hash: "#account" }),
    );
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "sessions")).toEqual(
      expect.objectContaining({ parent: "chat", label: "All conversations", hash: "#sessions" }),
    );
    expect(SETTINGS_OVERLAY_ENTRY).toEqual({
      id: "settings",
      label: "Settings",
      kind: "overlay",
      overlay: "settings",
      hash: "#settings",
    });
    expect(CANONICAL_DESTINATIONS.map((entry) => String(entry.id))).not.toContain(SETTINGS_OVERLAY_ENTRY.id);
  });
});
