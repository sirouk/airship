import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyPreferenceOverrides, approvalModeDescription, armBeforeUnloadGuard, scheduleTrailingValue, unloadWouldLoseWork, buildPaletteEntries, DEFAULT_PREFERENCES, filterPaletteEntries, loadPreferenceOverrides, loadRecentSessionPaletteSources, durabilityOptionLabel, durabilityOptions, durabilityRowNote, navigationJumpForChord, publishVisualViewportOffset, recentSessionPaletteSources, resolveDefaultVaultBackend, VAULT_BACKENDS, savePreferenceOverrides, trustAxesInScope, TRUST_SCOPE_BANDS, worstTrustAxis } from "./platform-shell";
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

  /*
   * The component was given an honest three-state contract and a safe default,
   * and the host was never wired to supply the state — so "Vault states what is
   * attached" was the only reachable branch of the three, on every build. The
   * unit tests above all pass the prop themselves, which is exactly why none of
   * them noticed. This asserts the integration point.
   */
  it("is told the adoption state at the one place the host renders it", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    const mounts = elementsNamed(app, "PreferencesDialog");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toContain("vaultAdopted={vaultRuntimeAdopted}");
    // The same value the Vault route's own adoption seal reads, so the two
    // surfaces cannot disagree about whether anything is attached.
    expect(elementsNamed(app, "VaultScreen")[0]).toContain("runtimeAdopted={vaultRuntimeAdopted}");
  });
});

/**
 * One JSX element's source per occurrence of `<Name`, brace- and quote-aware so
 * an arrow function in a handler and a `>` inside a string are ordinary
 * characters. The same scan `aria-name-contract.test.ts` uses.
 */
function elementsNamed(source: string, name: string): readonly string[] {
  const found: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "gu"))) {
    const start = match.index + match[0].length;
    let depth = 0;
    let quote = "";
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) { found.push(source.slice(start, index)); break; }
    }
  }
  return found;
}

describe("the confirmation shown for leaving the page", () => {
  /*
   * The shipped predicate was `busy || Boolean(sessionId)` — true from the
   * first frame of every visit, so the browser's "leave site?" dialog fired on
   * every reload, including on an adopted Vault whose journal survives one
   * intact and on a conversation with nothing in it. A prompt that is always
   * shown is a prompt that is always dismissed.
   */
  it("asks only when leaving would destroy something nothing can rebuild", () => {
    expect(unloadWouldLoseWork({ busy: false, eventCount: 0, vaultAdopted: false })).toBe(false);
    expect(unloadWouldLoseWork({ busy: false, eventCount: 12, vaultAdopted: true })).toBe(false);
    expect(unloadWouldLoseWork({ busy: false, eventCount: 12, vaultAdopted: false })).toBe(true);
    // A turn in flight can be lost mid-write wherever it is being written.
    expect(unloadWouldLoseWork({ busy: true, eventCount: 0, vaultAdopted: true })).toBe(true);
  });

  it("stays out of the way of a navigation Airship performs itself", () => {
    expect(unloadWouldLoseWork({ busy: true, eventCount: 12, vaultAdopted: false, reloading: true })).toBe(false);
  });

  it("releases the listener synchronously, because the reload does not wait for a render", () => {
    const listeners: Array<readonly [string, unknown]> = [];
    const target = {
      addEventListener: (type: string, listener: unknown) => { listeners.push([type, listener]); },
      removeEventListener: (type: string, listener: unknown) => {
        const index = listeners.findIndex(([candidate, held]) => candidate === type && held === listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };

    const release = armBeforeUnloadGuard(target as unknown as Window);
    expect(listeners.map(([type]) => type)).toEqual(["beforeunload"]);
    release();
    expect(listeners).toEqual([]);
    // Idempotent: the hook's own cleanup runs after the caller's release when
    // the reload is cancelled or the state settles first.
    release();
    expect(listeners).toEqual([]);
  });

  it("is armed from adoption and released by the update banner", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    expect(app).toContain("useBeforeUnloadGuard(unloadWouldLoseWork({");
    expect(app).not.toContain("useBeforeUnloadGuard(busy || Boolean(sessionId))");
    expect(elementsNamed(app, "PwaUpdateBanner")[0]).toContain("releaseUnloadGuard(); pwaUpdate.reload();");
  });
});

describe("the recents shortcuts refresh once per burst, not once per durable event", () => {
  /*
   * `sessionRevision` counts durable events, and one tool-calling turn writes a
   * dozen. Each one re-listed and re-decrypted the whole library twice — once
   * for the palette, once for the rail — for a sidebar that is unreadable
   * mid-stream anyway. Only the trailing value was ever going to be rendered.
   *
   * Driven through `scheduleTrailingValue` directly because the suite has no
   * DOM: `useEffect`'s contract is exactly "previous cleanup, then this
   * effect", which is the loop below.
   */
  it("collapses ten increments inside the window into one refresh", () => {
    vi.useFakeTimers();
    try {
      const listed: number[] = [];
      let cancel = () => {};
      for (let revision = 1; revision <= 10; revision += 1) {
        cancel();
        cancel = scheduleTrailingValue(revision, 250, (value) => listed.push(value));
        vi.advanceTimersByTime(20);
      }
      expect(listed).toEqual([]);
      vi.advanceTimersByTime(250);
      expect(listed).toEqual([10]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires both recents effects to the settled revision rather than the raw counter", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    expect(app).toContain("const settledSessionRevision = useDebouncedValue(sessionRevision, RECENTS_REFRESH_DEBOUNCE_MS);");
    expect(app).toContain("}, [sessionLibrary, settledSessionRevision, profileId]);");
    expect(app).toContain("}, [sessionLibrary, settledSessionRevision, profileId, sessionId]);");
    expect(app).not.toMatch(/\}, \[sessionLibrary, sessionRevision, profileId/u);
  });
});

describe("the frame the boot screen renders on", () => {
  /*
   * Display preferences are a synchronous localStorage read that used to be
   * applied by an effect gated on a resolved profile theme — the end of a
   * multi-await runtime boot. A Paper reader therefore got a full-screen dark
   * boot screen, off the stylesheet's default density and type ramp, for the
   * whole boot window.
   */
  it("applies the stored preference layer before the first render, ungated", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const apply = main.indexOf("applyPreferenceOverrides(loadPreferenceOverrides())");
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(main.indexOf("render(<App />"));

    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    // Saving is no longer gated on a theme either, and the preference layer
    // runs before the theme effect so the theme effect — which re-asserts these
    // same preferences over the theme's base — still commits last.
    expect(app).toContain("useEffect(() => {\n    savePreferenceOverrides(preferences);\n  }, [preferences]);");
    expect(app.indexOf("applyPreferenceOverrides(preferences);"))
      .toBeLessThan(app.indexOf("applyThemeWithPreferences(activeTheme, preferences);"));
  });

  it("stops the static document asserting a colour mode it cannot know", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(html).not.toContain('<meta name="color-scheme" content="dark" />');
    // `theme-color` keeps a pre-script default, but the applied layer rewrites
    // it from the ground the document actually resolved.
    expect(readFileSync(new URL("./platform-shell.tsx", import.meta.url), "utf8"))
      .toContain('document.querySelector<HTMLMetaElement>(\'meta[name="theme-color"]\')?.setAttribute("content", ground)');
  });
});

/** The transcript's resting floor: the foot of a 700px-tall `#app`. */
const RESTING_FLOOR = 700;
/** `.mobile-nav`'s `.app-shell` row, reclaimed by the 1fr track when it collapses. */
const NAV_TRACK = 56;

/**
 * A phone shell whose floor moves for the reasons the stylesheet moves it, and
 * for no others.
 *
 * Both terms are transcribed from `routes.css`'s phone block rather than
 * invented, because the previous fake asserted its own arithmetic: it shrank
 * the container by the published offset, which no rule did — the shipped
 * compensation was `position: relative; bottom` on `.composer-wrap`, a repaint
 * that moved no sibling box. It also omitted the nav track, which collapses on
 * `data-keyboard-open` and pushes the floor back *down*, so the fake could not
 * have caught a fix that scrolled the wrong way.
 *
 *   floor = #app height (100dvh − obscured) + the nav row the keyboard reclaims
 *
 * `respondsToKeyboard: false` is the same shell at a width where no rule
 * consumes the variable — a desktop layout — and it must produce no scroll.
 * The source-level counterpart (that a rule consuming it exists at all) is in
 * `composer-shell-contract.test.ts`; the pixel counterpart is
 * `e2e/composer-layout.spec.ts`.
 */
function fakePhoneShell(cardBottom: number, scrollTop = 1_000, respondsToKeyboard = true) {
  const scrolls: number[] = [];
  const values = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const floor = () => {
    if (!respondsToKeyboard) return RESTING_FLOOR;
    const obscured = Number.parseFloat(values.get("--visual-viewport-bottom") ?? "0") || 0;
    return RESTING_FLOOR - obscured + (dataset.keyboardOpen === "true" ? NAV_TRACK : 0);
  };
  const transcript = {
    scrollTop,
    getBoundingClientRect: () => ({ top: 120, bottom: floor() }),
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
      setProperty: (name: string, value: string) => { values.set(name, value); },
    },
    querySelector: () => transcript,
  };
  return { root: root as unknown as HTMLElement, dataset, scrolls, floor, transcript };
}

describe("the soft keyboard's effect on a pinned transcript", () => {
  it("re-anchors the last card after the keyboard takes the bottom of the transcript", () => {
    // The regression this pins: the keyboard moves the layout through CSS only
    // — no Preact state changes — so the transcript's own re-pin effect never
    // re-runs, and the reply the person just asked for scrolls out of the
    // shortened box.
    const shell = fakePhoneShell(690);
    publishVisualViewportOffset(shell.root, 336);
    expect(shell.dataset.keyboardOpen).toBe("true");
    // 700 − 336 obscured + 56 reclaimed from the nav track = a 420px floor, so
    // a card resting at 690 has to travel 270. Anything that reads the nav
    // collapse as the *only* change scrolls 56px the wrong way instead.
    expect(shell.floor()).toBe(420);
    expect(shell.scrolls).toEqual([1_270]);
    // The card is back on the floor of the shortened container, not below it.
    expect(shell.transcript.getBoundingClientRect().bottom).toBe(420);
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
    expect(shell.scrolls).toEqual([1_270, 990]);
  });

  it("does not scroll a layout whose floor the variable does not move", () => {
    // Every desktop width: `#app` is only sized to the visual viewport inside
    // the phone query, so the card is still on the floor and a re-anchor would
    // be the thing that moves it off — up to the 64px `isNearLastRealCard`
    // threshold, under a reader who never opened a keyboard.
    const shell = fakePhoneShell(690, 1_000, false);
    publishVisualViewportOffset(shell.root, 336);
    expect(shell.dataset.keyboardOpen).toBe("true");
    expect(shell.scrolls).toEqual([]);
  });

  it("ignores a pinch-pan that republishes the offset it already published", () => {
    // `visualViewport` fires `scroll` for every pan, not only for a keyboard.
    // Re-anchoring on those would yank the transcript under the reader's finger.
    const shell = fakePhoneShell(690);
    publishVisualViewportOffset(shell.root, 336);
    publishVisualViewportOffset(shell.root, 336.4);
    publishVisualViewportOffset(shell.root, 336);
    expect(shell.scrolls).toEqual([1_270]);
  });

  it("compensates for nothing while the page is pinch-zoomed", () => {
    // The unchanged-offset guard above cannot cover this: panning a zoomed page
    // changes `offsetTop` every frame, so `innerHeight − height − offsetTop`
    // genuinely moves and the guard passes. Zoom is a reader's gesture, not an
    // obscuring widget — publishing here would shrink the shell around them and
    // scroll the transcript under their finger, on desktop as well as phone.
    const shell = fakePhoneShell(690);
    publishVisualViewportOffset(shell.root, 336, 2);
    publishVisualViewportOffset(shell.root, 402, 2);
    expect(shell.scrolls).toEqual([]);
    expect(shell.dataset.keyboardOpen).toBeUndefined();
    expect(shell.root.style.getPropertyValue("--visual-viewport-bottom")).toBe("");

    // …and a real keyboard, once the reader pinches back out, still lands.
    publishVisualViewportOffset(shell.root, 336, 1);
    expect(shell.scrolls).toEqual([1_270]);
  });
});
