import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPreferenceOverrides, approvalModeDescription, buildPaletteEntries, DEFAULT_PREFERENCES, filterPaletteEntries, loadPreferenceOverrides, loadRecentSessionPaletteSources, durabilityOptionLabel, durabilityOptions, durabilityRowNote, navigationJumpForChord, publishVisualViewportOffset, recentSessionPaletteSources, resolveDefaultVaultBackend, VAULT_BACKENDS, savePreferenceOverrides, trustAxesInScope, TRUST_SCOPE_BANDS, worstTrustAxis } from "./platform-shell";
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

  it("carries Skills and Capabilities, which had no desktop entry point at all", () => {
    const visited: string[] = [];
    const entries = buildPaletteEntries({ navigate(view) { visited.push(view); }, openPreferences() {} });
    for (const [id, label] of [["skills", "Skills"], ["capabilities", "Capabilities"]] as const) {
      const entry = entries.find((candidate) => candidate.id === `view:${id}`);
      expect(entry?.label, `${id} is in the palette`).toBe(label);
      expect(filterPaletteEntries(entries, label).map((candidate) => candidate.label)).toContain(label);
      entry?.run();
    }
    expect(visited).toEqual(["skills", "capabilities"]);
  });

  it("describes All conversations with the scope the route enforces", () => {
    // The palette derives this line mechanically from the destination's scope
    // tag, so a wrong tag is wrong user-facing copy: the route lists the active
    // profile's conversations, never the whole journal.
    const entries = buildPaletteEntries({ navigate() {}, openPreferences() {} });
    expect(entries.find((entry) => entry.id === "view:sessions")?.description).toBe("Chat · Profile scope");
    expect(filterPaletteEntries(entries, "global").map((entry) => entry.label)).not.toContain("All conversations");
  });

  it("states what each approval mode really permits, without borrowed confinement", () => {
    // Full Access inherited the workspace tools' path confinement and applied
    // the word to every effect class, including `network`, which has none: an
    // allowed fetch may reach any HTTPS origin that grants CORS.
    const fullAccess = approvalModeDescription("full-access");
    expect(fullAccess).not.toContain("network boundaries");
    expect(fullAccess).toContain("any HTTPS origin");

    // Auto Approve is a provider round-trip per effectful action, and the
    // action body — script, command, URL — is exactly what is sent.
    const autoApprove = approvalModeDescription("auto-approve");
    expect(autoApprove).not.toContain("only bounded metadata");
    expect(autoApprove).toContain("sent to your active provider");
    expect(autoApprove).toContain("script, command or URL");
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

  it("offers every destination and greys the ones this deployment cannot reach", () => {
    // The availability predicate used to gate *loading* a persisted value and
    // nothing else, so the row happily offered Drive on a build with no client
    // ID and the MinIO lab on a public origin — choices the shell then had to
    // quietly correct behind the user.
    const configuredClientId = "123456789012-airship.apps.googleusercontent.com";
    const remote = durabilityOptions({ selected: "local-device", adoption: undefined, location: { hostname: "airship.example" } });
    expect(remote.map((option) => option.value)).toEqual([...VAULT_BACKENDS]);
    expect(remote.find((option) => option.value === "google-drive")).toMatchObject({ disabled: true });
    expect(remote.find((option) => option.value === "local-lab")).toMatchObject({ disabled: true });
    expect(remote.find((option) => option.value === "local-lab")?.description).toMatch(/loopback/iu);
    expect(remote.find((option) => option.value === "google-drive")?.description).toMatch(/client ID/iu);
    for (const reachable of ["local-device", "ephemeral"] as const) {
      expect(remote.find((option) => option.value === reachable)?.disabled).toBeUndefined();
    }

    // The lab origin the e2e vault-adoption journey runs on, and every loopback
    // spelling `isLoopbackAirshipLocation` accepts in `app.tsx`.
    for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]"] as const) {
      const loopback = durabilityOptions({ selected: "local-device", adoption: undefined, location: { hostname } });
      expect(loopback.find((option) => option.value === "local-lab")?.disabled, hostname).toBeUndefined();
    }

    const deployable = durabilityOptions({ selected: "local-device", adoption: undefined, googleClientId: configuredClientId, location: { hostname: "airship.example" } });
    expect(deployable.find((option) => option.value === "google-drive")?.disabled).toBeUndefined();

    // No location supplied is "not asked", not "unreachable": a stored choice
    // must never be rewritten by the absence of a question.
    const unasked = durabilityOptions({ selected: "local-lab", adoption: undefined });
    expect(unasked.find((option) => option.value === "local-lab")?.disabled).toBeUndefined();
  });

  it("keeps the destination's consequence as its description while it is reachable", () => {
    const options = durabilityOptions({ selected: "local-device", adoption: "connected", vaultAdopted: true, location: { hostname: "localhost" } });
    expect(options.find((option) => option.value === "local-device")).toEqual({
      value: "local-device",
      label: "This device · connected",
      description: "Encrypted here. Not on your other devices.",
    });
    // Every other destination is reported against the vault state the host did
    // supply, which is the same under-claiming rule `durabilityOptionLabel` has.
    expect(options.find((option) => option.value === "local-lab")?.label).toBe("Local MinIO lab · not connected");
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

/**
 * A phone shell whose geometry answers the way a real one does. Publishing the
 * obscured height is itself what lifts the composer and widens the transcript's
 * bottom padding, so the container's floor rises at exactly that moment, and
 * scrolling the container moves the last card with it.
 */
function fakePhoneShell(cardBottom: number, scrollTop = 1_000) {
  const scrolls: number[] = [];
  const values = new Map<string, string>();
  const dataset: Record<string, string> = {};
  let floor = 700;
  const transcript = {
    scrollTop,
    getBoundingClientRect: () => ({ top: 120, bottom: floor }),
    querySelectorAll: () => ({
      length: 1,
      item: (index: number) => (index === 0 ? card : null),
    }),
    scrollTo(target: { top: number }) {
      scrolls.push(target.top);
      this.scrollTop = target.top;
    },
  };
  const card = {
    getBoundingClientRect: () => ({
      top: cardBottom - 120 - (transcript.scrollTop - scrollTop),
      bottom: cardBottom - (transcript.scrollTop - scrollTop),
    }),
  };
  const root = {
    dataset,
    style: {
      getPropertyValue: (name: string) => values.get(name) ?? "",
      setProperty(name: string, value: string) {
        values.set(name, value);
        if (name === "--visual-viewport-bottom") floor = 700 - Number.parseFloat(value);
      },
    },
    querySelector: () => transcript,
  };
  return { root: root as unknown as HTMLElement, dataset, scrolls, floor: () => floor, transcript };
}

describe("the soft keyboard's effect on a pinned transcript", () => {
  it("re-anchors the last card after the keyboard takes the bottom of the transcript", () => {
    // The regression this pins: the keyboard moves the layout through CSS only
    // — no Preact state changes — so the transcript's own re-pin effect never
    // re-runs, and the reply the person just asked for ends up under the lifted
    // composer.
    const shell = fakePhoneShell(690);
    publishVisualViewportOffset(shell.root, 336);
    expect(shell.dataset.keyboardOpen).toBe("true");
    expect(shell.scrolls).toEqual([1_326]);
    // The card is back on the floor of the shortened container, not below it.
    expect(shell.transcript.getBoundingClientRect().bottom).toBe(364);
  });

  it("leaves a transcript the reader scrolled away from exactly where they left it", () => {
    const shell = fakePhoneShell(900);
    publishVisualViewportOffset(shell.root, 336);
    expect(shell.dataset.keyboardOpen).toBe("true");
    expect(shell.scrolls).toEqual([]);
  });

  it("returns the anchored card to the floor when the keyboard closes", () => {
    const shell = fakePhoneShell(690);
    publishVisualViewportOffset(shell.root, 336);
    publishVisualViewportOffset(shell.root, 0);
    expect(shell.dataset.keyboardOpen).toBe("false");
    expect(shell.scrolls).toEqual([1_326, 990]);
  });

  it("ignores a pinch-pan that republishes the offset it already published", () => {
    // `visualViewport` fires `scroll` for every pan, not only for a keyboard.
    // Re-anchoring on those would yank the transcript under the reader's finger.
    const shell = fakePhoneShell(690);
    publishVisualViewportOffset(shell.root, 336);
    publishVisualViewportOffset(shell.root, 336.4);
    publishVisualViewportOffset(shell.root, 336);
    expect(shell.scrolls).toEqual([1_326]);
  });
});
