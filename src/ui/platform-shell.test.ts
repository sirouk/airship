import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPreferenceOverrides, buildPaletteEntries, DEFAULT_PREFERENCES, filterPaletteEntries, loadPreferenceOverrides, loadRecentSessionPaletteSources, durabilityOptionLabel, durabilityRowNote, navigationJumpForChord, recentSessionPaletteSources, resolveDefaultVaultBackend, VAULT_BACKENDS, savePreferenceOverrides, trustAxesInScope, TRUST_SCOPE_BANDS, worstTrustAxis } from "./platform-shell";
import { CANONICAL_DESTINATIONS } from "./navigation-model";

describe("platform shell contracts", () => {
  it("defaults to Drive only when this build can open Google authorization", () => {
    const configuredClientId = "123456789012-airship.apps.googleusercontent.com";
    expect(resolveDefaultVaultBackend(undefined, configuredClientId)).toBe("google-drive");
    expect(resolveDefaultVaultBackend("google-drive", configuredClientId)).toBe("google-drive");
    expect(resolveDefaultVaultBackend(undefined)).toBe("local-device");
    expect(resolveDefaultVaultBackend(undefined, undefined)).toBe("local-device");
    expect(resolveDefaultVaultBackend("google-drive", "malformed")).toBe("local-device");
    expect(resolveDefaultVaultBackend("local-lab", undefined)).toBe("local-lab");
    expect(resolveDefaultVaultBackend("unexpected", configuredClientId)).toBe("google-drive");
    expect(resolveDefaultVaultBackend("unexpected", undefined)).toBe("local-device");
  });

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

  it("makes appearance choices visual and requires confirmation before a broad reset", () => {
    const dialog = readFileSync(new URL("./platform-shell.tsx", import.meta.url), "utf8");
    expect(dialog).toContain('mode === "dark" ? "moon" : "sun"');
    expect(dialog).toContain('window.confirm("Reset display, durability, and legacy approval preferences to their defaults?")');
  });

  it("downgrades a stale Drive preference to the configured available default", () => {
    const configuredClientId = "123456789012-airship.apps.googleusercontent.com";
    const staleDrive = JSON.stringify({ ...DEFAULT_PREFERENCES, vaultBackend: "google-drive" });
    const storage = { getItem: () => staleDrive };
    expect(loadPreferenceOverrides(storage, {
      googleClientId: undefined,
      defaultVaultBackend: "local-device",
    }).vaultBackend).toBe("local-device");
    expect(loadPreferenceOverrides(storage, {
      googleClientId: undefined,
      defaultVaultBackend: "local-lab",
    }).vaultBackend).toBe("local-lab");
    expect(loadPreferenceOverrides(storage, {
      googleClientId: configuredClientId,
      defaultVaultBackend: "local-device",
    }).vaultBackend).toBe("google-drive");
  });

  it("picks the weakest trust axis without changing its claim", () => {
    const axes = [
      { id: "local", scope: "tab", label: "Local runtime", state: "verified", detail: "On device", view: "proof" },
      { id: "attestation", scope: "conversation", label: "Endpoint not checked", state: "asserted", detail: "Encrypted only", view: "proof" },
    ] as const;
    expect(worstTrustAxis(axes)).toBe(axes[1]);
  });

  /*
   * The scope partition is what stops one fact being printed in two bands. It
   * is asserted here rather than only in the topbar because the split has to
   * survive an axis being added: an untagged axis is a compile error, and a
   * mis-tagged one shows up as a band claiming something it does not own.
   */
  it("partitions axes by the band that owns them", () => {
    const axes = [
      { id: "local", scope: "tab", label: "Local runtime", state: "verified", detail: "On device", view: "proof" },
      { id: "vault", scope: "tab", label: "No vault adopted", state: "none", detail: "No cloud vault is configured.", view: "vault" },
      { id: "e2ee", scope: "conversation", label: "Connect a model", state: "none", detail: "Nothing connected.", view: "access" },
      { id: "attestation", scope: "conversation", label: "Endpoint not checked", state: "asserted", detail: "Encrypted only", view: "proof" },
    ] as const;

    expect(trustAxesInScope(axes, "tab").map((axis) => axis.id)).toEqual(["local", "vault"]);
    expect(trustAxesInScope(axes, "conversation").map((axis) => axis.id)).toEqual(["e2ee", "attestation"]);
    // Every axis lands in exactly one band; none is orphaned by the partition.
    expect(trustAxesInScope(axes, "tab").length + trustAxesInScope(axes, "conversation").length).toBe(axes.length);
    expect(TRUST_SCOPE_BANDS.conversation.restingHome).toContain("session bar");
    expect(TRUST_SCOPE_BANDS.tab.restingHome).toContain("topbar");
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

describe("the Durability row states a destination and its state, never one as the other", () => {
  it("never prints an adoption Preferences has not been told about", () => {
    // The measured contradiction: this row read "Encrypted Google Drive ·
    // cross-device" while `#vault` read "Disconnected | No vault claim | No
    // cloud vault is configured." A host that passes no vault state gets the
    // destination and no claim at all, which can only under-claim.
    for (const backend of VAULT_BACKENDS) {
      expect(durabilityOptionLabel(backend, undefined)).not.toMatch(/connected/iu);
      expect(durabilityOptionLabel(backend, undefined)).not.toMatch(/encrypted/iu);
    }
    expect(durabilityOptionLabel("google-drive", undefined)).toBe("Google Drive");
  });

  it("reuses the Vault route's own words once it has been told", () => {
    expect(durabilityOptionLabel("google-drive", "not-connected")).toBe("Google Drive · not connected");
    expect(durabilityOptionLabel("google-drive", "connected")).toBe("Google Drive · connected");
    expect(durabilityOptionLabel("local-device", "not-connected")).toBe("This device · not connected");
  });

  it("keeps page memory out of the adoption axis entirely", () => {
    // Choosing page memory *is* the state. "Page memory only · not connected"
    // would invent a failure out of a deliberate choice — the same mistake
    // `vaultPhaseLabel` fixed on the Vault route by refusing to say
    // "Disconnected" for a vault that was never created.
    for (const adoption of ["connected", "not-connected", undefined] as const) {
      expect(durabilityOptionLabel("ephemeral", adoption)).toBe("Page memory only");
    }
  });

  it("says what is attached in the state the row is actually in", () => {
    expect(durabilityRowNote("not-connected")).toBe("Where conversations survive a closed tab. Nothing is attached yet — set it up in Vault.");
    expect(durabilityRowNote("connected")).toContain("Vault holds it, and can detach it");
    // Unknown may not claim either way, and must still point at the surface
    // that does know.
    expect(durabilityRowNote(undefined)).not.toMatch(/nothing is attached|Vault holds it/iu);
    for (const adoption of ["connected", "not-connected", undefined] as const) {
      expect(durabilityRowNote(adoption)).toContain("Vault");
      expect(durabilityRowNote(adoption)).toContain("Where conversations survive a closed tab.");
    }
  });

  it("carries the consequence of each destination beside it", () => {
    const dialog = readFileSync(new URL("./platform-shell.tsx", import.meta.url), "utf8");
    expect(dialog).toContain("Nothing survives closing this tab.");
    expect(dialog).toContain("DURABILITY[backend][1]");
    // The row's own divider, so a claim about the world is not read as the
    // ninth in a run of presentation rows.
    expect(dialog).toContain('<p class="preferences-dialog__divider">Storage</p>');
    // The component owns the axis, rather than a stylesheet forcing the sheet
    // downward while `MenuSelect` still believes it opens upward — which is how
    // the last row came to open a list the dialog's own scroll box clipped.
    expect(dialog).toMatch(/<MenuSelect[^>]*\splacement=\{placement\}/su);
    // The row that runs out of room downward opens upward instead.
    expect(dialog).toMatch(/label="Durability"[\s\S]{0,200}placement="up"/u);
    expect(readFileSync(new URL("./platform-shell.css", import.meta.url), "utf8"))
      .not.toMatch(/\.preference-menu \.menu-select-popover \{ top:/u);
  });
});
