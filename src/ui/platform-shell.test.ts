import { describe, expect, it } from "vitest";
import { applyPreferenceOverrides, buildPaletteEntries, DEFAULT_PREFERENCES, filterPaletteEntries, loadPreferenceOverrides, loadRecentSessionPaletteSources, navigationJumpForChord, recentSessionPaletteSources, savePreferenceOverrides, worstTrustAxis } from "./platform-shell";
import { CANONICAL_DESTINATIONS } from "./navigation-model";

describe("platform shell contracts", () => {
  it("makes every canonical and nested destination plus preferences reachable", () => {
    const entries = buildPaletteEntries({ navigate() {}, openPreferences() {} });
    const expected = CANONICAL_DESTINATIONS.flatMap((item) => [item.id, ...item.nested.map((nested) => nested.id)]);
    for (const id of expected) expect(entries.some((entry) => entry.id === `view:${id}`)).toBe(true);
    expect(entries.some((entry) => entry.id === "settings")).toBe(true);
  });

  it("filters across labels, hashes, group, and keywords", () => {
    const entries = buildPaletteEntries({ navigate() {}, openPreferences() {} });
    expect(filterPaletteEntries(entries, "conn").map((entry) => entry.label)).toContain("Connection");
    expect(filterPaletteEntries(entries, "#account").map((entry) => entry.label)).toContain("Account");
    expect(filterPaletteEntries(entries, "paper").map((entry) => entry.label)).toContain("Preferences");
  });

  it("applies only global personality and layout overrides", () => {
    const values = new Map<string, string>();
    const root = {
      dataset: {} as DOMStringMap,
      style: {
        colorScheme: "",
        getPropertyValue(name: string) { return values.get(name) ?? ""; },
      },
    } as unknown as HTMLElement;
    applyPreferenceOverrides({ ...DEFAULT_PREFERENCES, mode: "light", typeScale: "x-large" }, root);
    expect(root.dataset.mode).toBe("light");
    expect(root.dataset.typeScale).toBe("x-large");
    expect(root.style.getPropertyValue("--v-verified")).toBe("");
    expect(root.style.colorScheme).toBe("light");
  });

  it("persists validated global display preferences and falls back on malformed storage", () => {
    let raw: string | null = null;
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
    const compact = { ...DEFAULT_PREFERENCES, density: "compact" as const, mode: "light" as const };
    savePreferenceOverrides(compact, storage);
    expect(loadPreferenceOverrides(storage)).toEqual(compact);
    raw = "not-json";
    expect(loadPreferenceOverrides(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it("picks the weakest trust axis without changing its claim", () => {
    const axes = [
      { id: "local", label: "Local runtime", state: "verified", detail: "On device", view: "proof" },
      { id: "attestation", label: "Endpoint not checked", state: "asserted", detail: "Encrypted only", view: "attestations" },
    ] as const;
    expect(worstTrustAxis(axes)).toBe(axes[1]);
  });

  it("maps g chords to high-traffic destinations and ignores incomplete chords", () => {
    expect(navigationJumpForChord("g", "c")).toBe("chat");
    expect(navigationJumpForChord("g", "T")).toBe("proof");
    expect(navigationJumpForChord(undefined, "c")).toBeUndefined();
    expect(navigationJumpForChord("g", "q")).toBeUndefined();
  });

  it("bounds recent session palette sources and preserves identity", () => {
    const opened: string[] = [];
    const sessions = Array.from({ length: 20 }, (_, index) => ({ id: `session-${index}`, title: `Session ${index}` })) as never;
    const sources = recentSessionPaletteSources(sessions, (id) => opened.push(id));
    expect(sources).toHaveLength(12);
    expect(sources[0]?.id).toBe("session-0");
    sources[0]?.open();
    expect(opened).toEqual(["session-0"]);
  });

  it("requests the twelve most recently updated sessions", async () => {
    const queries: unknown[] = [];
    const library = { async list(query: unknown) { queries.push(query); return { items: [{ id: "recent", title: "Recent" }] }; } };
    const result = await loadRecentSessionPaletteSources(library as never, () => {});
    expect(queries).toEqual([{ sort: "updated-desc", limit: 12 }]);
    expect(result.map((item) => item.id)).toEqual(["recent"]);
  });

  it("can scope sidebar recents to the active profile without changing global palette behavior", async () => {
    const queries: unknown[] = [];
    const library = { async list(query: unknown) { queries.push(query); return { items: [] }; } };
    await loadRecentSessionPaletteSources(library as never, () => {}, undefined, "researcher");
    expect(queries).toEqual([{ sort: "updated-desc", limit: 12, profileId: "researcher" }]);
  });
});
