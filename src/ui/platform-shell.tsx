import { Component, type ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SlashCommandDescriptor } from "../commands/types";
import type { SessionListItem } from "../sessions/domain";
import { CANONICAL_DESTINATIONS, destinationLabel, navigationHashForView, SETTINGS_OVERLAY_ENTRY, type NavigationView } from "./navigation-model";
import { StatusMark, type StatusMarkState } from "./status-mark";
import type { ApprovalMode } from "../approvals/modes";
import { MenuSelect } from "./menu-select";
import { isDeployableGoogleOAuthClientId } from "../storage/google-drive-configuration";
import { Icon } from "./icons";
import {
  DEFAULT_TRANSCRIPT_OPERATIONS,
  parseTranscriptOperationsMode,
  setTranscriptOperationsMode,
  type TranscriptOperationsMode,
} from "./chat/transcript-operations";
import { isNearLastRealCard, scrollToLastRealCard } from "./chat/transcript-anchor";
import { readReloadRisk, reloadWouldDiscardWork } from "./reload-risk";
import { useBottomFloor } from "./bottom-floor";

export type PaletteEntry = Readonly<{
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  group: "Navigate" | "Commands" | "Sessions" | "Setup" | "Preferences" | "Actions";
  /**
   * Set for entries the runtime has declared unavailable right now. The row
   * stays listed with its reason as the description — the same contract
   * `MenuSelect` keeps for disabled options — but choosing it is a no-op
   * that must not dismiss the palette.
   */
  disabled?: boolean;
  run(): void;
}>;

export function buildPaletteEntries(args: Readonly<{
  navigate(view: NavigationView): void;
  openPreferences(): void;
  /**
   * The shortcut sheet, as a palette row.
   *
   * Measured: palette queries "shortcut", "keyboard" and "chord" each returned
   * "No matching destination or command." on a product that binds eleven of
   * them, so the one surface that could have taught the keyboard layer could
   * not even find the word for it.
   */
  openShortcuts?(): void;
  commands?: readonly SlashCommandDescriptor[];
  runCommand?(command: string): void;
  sessions?: readonly Readonly<{ id: string; title: string; open(): void }>[];
  /**
   * Every managed profile, as a verb.
   *
   * The palette held no verbs at all, so the thing a multi-profile person does
   * most had no keyboard path: the "Agent profile" control was the 24th tab
   * stop and `NAVIGATION_JUMPS` bound no chord to it. `g 1`…`g 9` reach the
   * same rows from the transcript in three keystrokes.
   */
  profiles?: readonly Readonly<{ profileId: string; name: string; description?: string; active: boolean; switchTo(): void }>[];
  /**
   * The shell's own verbs, as palette rows.
   *
   * Measured: "new conversation", "retry" and "rename" each returned "No
   * matching destination or command." while the live shell rendered buttons of
   * exactly those names — so every action still cost menu archaeology, on the
   * one surface a keyboard-first person reaches for first. A verb states its
   * own refusal here rather than being withheld: `reason` fills the row's
   * description and disables it, the contract disabled commands already keep.
   */
  actions?: readonly Readonly<{
    id: string;
    label: string;
    description: string;
    keywords?: readonly string[];
    reason?: string;
    run(): void;
  }>[];
}>): readonly PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const destination of CANONICAL_DESTINATIONS) {
    entries.push(Object.freeze({
      id: `view:${destination.id}`,
      label: destination.label,
      description: `${destination.group} · ${scopeLabel(destination.scope)}${chordSuffix(destination.id)}`,
      keywords: [destination.id, destination.hash, destination.group, destination.scope],
      group: destination.group === "Setup" ? "Setup" : "Navigate",
      run: () => args.navigate(destination.id),
    }));
    /*
     * `g x` is the only route to #context anywhere in the product: the hash is
     * deliberately outside `CanonicalDestinationId`, so it has no rail row, no
     * `MOBILE_MORE_ENTRIES` entry and — until this row — no palette entry, i.e.
     * a destination reachable only by a chord that nothing printed. It is
     * Memory opened on its index tab, so it takes Memory's name and scope
     * rather than starting a second table of destination names.
     */
    if (destination.id === "memory") entries.push(Object.freeze({
      id: "view:context",
      label: `${destination.label} index`,
      description: `${destination.label} · ${scopeLabel(destination.scope)}${chordSuffix("context")}`,
      keywords: ["context", navigationHashForView("context"), "index", destination.label],
      group: "Navigate",
      run: () => args.navigate("context"),
    }));
    for (const nested of destination.nested) entries.push(Object.freeze({
      id: `view:${nested.id}`,
      label: nested.label,
      description: `${destination.label} · ${scopeLabel(nested.scope)}${chordSuffix(nested.id)}`,
      keywords: [nested.id, nested.hash, destination.label],
      group: destination.group === "Setup" ? "Setup" : "Navigate",
      run: () => args.navigate(nested.id),
    }));
  }
  (args.profiles ?? []).forEach((profile, index) => entries.push(Object.freeze({
    id: `profile:${profile.profileId}`,
    label: profile.active ? `${profile.name} · active profile` : `Switch to ${profile.name}`,
    description: `Agent profile${profileChordHint(index) ? ` · ${profileChordHint(index)}` : ""}${profile.description ? ` · ${profile.description}` : ""}`,
    keywords: ["profile", "switch", "change profile", "agent", profile.profileId, profile.name],
    group: "Navigate",
    ...(profile.active ? { disabled: true } : {}),
    run: profile.switchTo,
  })));
  for (const action of args.actions ?? []) entries.push(Object.freeze({
    id: `action:${action.id}`,
    label: action.label,
    description: action.reason ?? action.description,
    keywords: action.keywords ?? [],
    group: "Actions",
    ...(action.reason ? { disabled: true } : {}),
    run: action.run,
  }));
  entries.push(Object.freeze({
    id: SETTINGS_OVERLAY_ENTRY.id,
    label: "Preferences",
    description: "Display, storage, and browser-agent approvals",
    keywords: ["settings", "theme", "mode", "paper", "dark", "approval", "full access", "auto approve"],
    group: "Preferences",
    run: args.openPreferences,
  }));
  if (args.openShortcuts) entries.push(Object.freeze({
    id: "shortcuts",
    label: "Keyboard shortcuts",
    description: `Every chord this shell binds · ${SHORTCUT_SHEET_CHORD}`,
    keywords: ["keyboard", "shortcut", "shortcuts", "chord", "chords", "keys", "hotkey", "accelerator", "?"],
    group: "Preferences",
    run: args.openShortcuts,
  }));
  for (const command of args.commands ?? []) entries.push(Object.freeze({
    id: `command:${command.name}`,
    label: `/${command.name}`,
    description: command.availability.enabled ? command.summary : command.availability.reason ?? "Unavailable",
    keywords: [...command.aliases, command.category, command.usage],
    group: "Commands",
    ...(command.availability.enabled ? {} : { disabled: true }),
    run: () => {
      if (command.availability.enabled) args.runCommand?.(`/${command.name} `);
    },
  }));
  for (const session of (args.sessions ?? []).slice(0, 12)) entries.push(Object.freeze({
    id: `session:${session.id}`,
    label: session.title,
    description: `Recent session · ${shortId(session.id)}`,
    keywords: [session.id, "recent", "session"],
    group: "Sessions",
    run: session.open,
  }));
  return Object.freeze(entries);
}

export function recentSessionPaletteSources(
  sessions: readonly SessionListItem[],
  open: (sessionId: string) => void,
  limit = 12,
): readonly Readonly<{ id: string; title: string; open(): void }>[] {
  return Object.freeze(sessions.slice(0, Math.max(0, Math.min(12, limit))).map((session) => Object.freeze({
    id: session.id,
    title: session.title,
    open: () => open(session.id),
  })));
}

export async function loadRecentSessionPaletteSources(
  library: Readonly<{ list(query: Readonly<{ sort: "updated-desc"; limit: number; profileId?: string }>, signal?: AbortSignal): Promise<Readonly<{ items: readonly SessionListItem[] }>> }>,
  open: (sessionId: string) => void,
  signal?: AbortSignal,
  profileId?: string,
): Promise<readonly Readonly<{ id: string; title: string; open(): void }>[]> {
  const page = await library.list({ sort: "updated-desc", limit: 12, ...(profileId ? { profileId } : {}) }, signal);
  if (signal?.aborted) return Object.freeze([]);
  return recentSessionPaletteSources(page.items, open);
}

/**
 * Anything an overlay draws. A control inside one of these is never the control
 * that opened it, so it can never become the thing focus is handed back to.
 */
const OVERLAY_ROOTS = "[role='dialog'], .platform-scrim, .approval-scrim, .mobile-sheet";

/**
 * Who gets the keyboard back when an overlay closes.
 *
 * Measured: Escape from the command palette or from Preferences dropped focus
 * on `<body>`, from where the composer's autofocus claimed it — 21 Shift+Tab
 * presses from the control the person had opened the overlay with. The cause
 * was that both dialogs captured `document.activeElement` inside a post-commit
 * effect, and the commit that opens an overlay is the same one that marks the
 * shell `inert`: the opener has already been blurred by the time the effect
 * runs, so the capture could only ever read `<body>`.
 *
 * `mobile-navigation.tsx` holds the other half of this contract with an
 * explicit `moreButton` ref, which is why the phone's More sheet always
 * restored correctly. These two overlays have many openers — a topbar button,
 * ⌘K from anywhere, a More-sheet row — so instead of a ref per call site the
 * shell remembers the last focus *outside* any overlay, captured from the
 * `focusout` the inerting itself fires, one commit before the effect.
 */
export function useOpenerRestore(open: boolean): void {
  const opener = useRef<HTMLElement>();
  const lastOutside = useRef<HTMLElement>();
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== document.body && !target.closest(OVERLAY_ROOTS)) {
        lastOutside.current = target;
      }
    };
    document.addEventListener("focusout", remember, true);
    return () => document.removeEventListener("focusout", remember, true);
  }, []);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body && !active.closest(OVERLAY_ROOTS)
      ? active
      : lastOutside.current;
    return () => {
      const target = opener.current;
      if (!target?.isConnected) return;
      target.focus({ preventScroll: true });
      // The shell lifts `inert` on the commit that closes the overlay, and
      // focusing an element still inside an inert subtree silently does
      // nothing — the same one-frame race `approval-dock.tsx` documents.
      if (document.activeElement === target) return;
      requestAnimationFrame(() => { if (target.isConnected) target.focus({ preventScroll: true }); });
    };
  }, [open]);
}


export function useGlobalPaletteShortcut(toggle: () => void): void {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export const NAVIGATION_JUMPS: Readonly<Record<string, NavigationView>> = Object.freeze({
  c: "chat", s: "sessions", w: "workspace", m: "memory", x: "context", p: "profiles", t: "terminal", n: "access",
});

export function navigationJumpForChord(prefix: string | undefined, key: string): NavigationView | undefined {
  return prefix === "g" ? NAVIGATION_JUMPS[key.toLocaleLowerCase()] : undefined;
}

/** How many profiles the `g <digit>` chord can reach. Nine keys, nine profiles. */
export const PROFILE_CHORD_LIMIT = 9;

/**
 * The profile a `g <digit>` chord names, as a zero-based index into the managed
 * profiles in the order the shell lists them.
 *
 * Switching profile is the thing a multi-profile person does several times an
 * hour and it had no keyboard path at all: the control was the 24th tab stop,
 * `NAVIGATION_JUMPS` bound nothing to it, and the palette answered "switch"
 * with "No matching destination or command." A profile is a place in this
 * product — its own conversations, drafts, terminal and workspace — so it takes
 * the `g` prefix the other destinations use.
 */
export function profileJumpForChord(prefix: string | undefined, key: string): number | undefined {
  if (prefix !== "g" || !/^[1-9]$/u.test(key)) return undefined;
  return Number(key) - 1;
}

export function profileChordHint(index: number): string | undefined {
  return index >= 0 && index < PROFILE_CHORD_LIMIT ? `g ${index + 1}` : undefined;
}

/**
 * The chord that reaches a destination, in the form a person types it.
 *
 * Eight `g`-prefixed chords shipped with no discovery surface: the palette
 * footer printed only `↑↓ choose` and `↵ open`, and the two shortcuts that were
 * discoverable at all (`⌘K`, `⌘\`) got there through `title` tooltips a touch
 * user never sees. Read straight out of `NAVIGATION_JUMPS` so the printed chord
 * and the bound chord cannot drift — a legend maintained by hand is how a
 * shortcut sheet ends up teaching a key that was rebound two releases ago.
 */
export function navigationChordHint(view: NavigationView): string | undefined {
  for (const [key, destination] of Object.entries(NAVIGATION_JUMPS)) {
    if (destination === view) return `g ${key}`;
  }
  return undefined;
}

function chordSuffix(view: NavigationView): string {
  const chord = navigationChordHint(view);
  return chord ? ` · ${chord}` : "";
}

export function useGlobalNavigationJumps(
  navigate: (view: NavigationView) => void,
  enabled?: () => boolean,
  /** `g 1`…`g 9`. Kept in this handler so one `g` prefix serves every chord. */
  switchProfile?: (index: number) => void,
): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const switchProfileRef = useRef(switchProfile);
  switchProfileRef.current = switchProfile;
  useEffect(() => {
    let prefix: string | undefined;
    let timeout = 0;
    const clear = () => { prefix = undefined; window.clearTimeout(timeout); timeout = 0; };
    const onKeyDown = (event: KeyboardEvent) => {
      /*
       * Chords must not fire underneath a modal overlay. The shell makes the
       * routed surface inert while one is open, but inert only suppresses
       * pointer/focus interaction — a window-level keydown still lands, so a
       * `g` chord used to swap the route and push history invisibly behind
       * the dialog. `enabled` is the host's overlay gate; when it says closed
       * the chord (and any pending `g` prefix) is dropped.
       */
      if (enabledRef.current && !enabledRef.current()) { clear(); return; }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) { clear(); return; }
      if (!prefix && event.key.toLocaleLowerCase() === "g") {
        prefix = "g";
        timeout = window.setTimeout(clear, 900);
        return;
      }
      const destination = navigationJumpForChord(prefix, event.key);
      const profileIndex = destination ? undefined : profileJumpForChord(prefix, event.key);
      clear();
      if (destination) {
        event.preventDefault();
        navigateRef.current(destination);
        return;
      }
      if (profileIndex === undefined || !switchProfileRef.current) return;
      event.preventDefault();
      switchProfileRef.current(profileIndex);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { clear(); window.removeEventListener("keydown", onKeyDown); };
  }, []);
}

/**
 * The key that opens the sheet, printed everywhere the sheet is offered.
 *
 * `?`, `F1` and `Shift+/` all produced `[]` dialogs on the shipped build, and
 * Preferences had no keyboard section, so eleven bound chords had no printed
 * form anywhere in the product.
 */
export const SHORTCUT_SHEET_CHORD = "?";

/**
 * `?` from anywhere that is not a text field.
 *
 * Separate from `useGlobalPaletteShortcut` because it must not fire while the
 * person is typing a question mark, and separate from the chord handler because
 * it takes no prefix.
 */
export function useGlobalShortcutSheet(open: () => void, enabled?: () => boolean): void {
  const openRef = useRef(open);
  openRef.current = open;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (enabledRef.current && !enabledRef.current()) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== SHORTCUT_SHEET_CHORD && event.key !== "F1") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      openRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export type PreferenceOverrides = Readonly<{
  mode: "dark" | "light";
  typeScale: "default" | "large" | "x-large";
  density: "comfortable" | "compact";
  corners: "subtle" | "square" | "rounded";
  bodyFont: "system-sans" | "system-serif";
  /**
   * Durable-storage backend. A configured build may default to the user-owned
   * Google Drive transport; otherwise Airship starts in explicit Ephemeral page
   * memory until a person chooses a durable provider.
   */
  vaultBackend: "local-device" | "google-drive" | "local-lab" | "ephemeral";
  approvalMode: ApprovalMode;
  /**
   * Expert override for the transcript's tool rows. `summary` collapses a
   * settled, wholly-completed run of four or more steps to its header;
   * `rows` never collapses. Neither hides that a step occurred or which
   * tool ran, and any failure or denial keeps the rows open in both.
   */
  transcriptOperations: TranscriptOperationsMode;
}>;

export type VaultBackend = PreferenceOverrides["vaultBackend"];

/** Exact opt-in for the host-composed loopback storage lab. */
export function localLabEnabledInBuild(value: string | undefined): boolean {
  return value === "1";
}

const BUILD_LOCAL_LAB_ENABLED = localLabEnabledInBuild(
  import.meta.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB as string | undefined,
);

export type VaultBackendSelectorAvailability = Readonly<{
  googleClientId?: string | null;
  localLabEnabled?: boolean;
  location?: Pick<Location, "hostname">;
}>;

function browserVaultLocation(): Pick<Location, "hostname"> | undefined {
  return typeof window === "undefined" ? undefined : window.location;
}

/**
 * Whether this deployment can actually open a destination.
 *
 * Local MinIO is not a stock backend. It needs both the exact build-time host
 * composition opt-in and an exact loopback page origin. Missing either fact is
 * a refusal, including during persisted-value migration.
 */
function availableVaultBackend(
  value: unknown,
  googleClientId?: string | null,
  location?: Pick<Location, "hostname">,
  localLabEnabled = BUILD_LOCAL_LAB_ENABLED,
): VaultBackend | undefined {
  if (value === "google-drive") {
    return isDeployableGoogleOAuthClientId(googleClientId) ? value : undefined;
  }
  if (value === "local-lab") {
    return localLabEnabled && location && isLoopbackVaultOrigin(location) ? value : undefined;
  }
  return value === "local-device" || value === "ephemeral" ? value : undefined;
}

/**
 * The same origin test the local-lab auto-connect in `app.tsx` applies before
 * it will talk to the baked MinIO endpoint. It is restated rather than imported
 * because `app.tsx` imports this module: taking the dependency the other way
 * would close an evaluation cycle through a 7,000-line shell module. The two
 * are pinned together by `platform-shell.test.ts`, which asserts the same four
 * loopback spellings `local-lab-namespace.test.ts` asserts of the original.
 */
function isLoopbackVaultOrigin(location: Pick<Location, "hostname">): boolean {
  const hostname = location.hostname.trim().toLocaleLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function resolveDefaultVaultBackend(
  value: string | undefined,
  googleClientId?: string | null,
  localLabEnabled = BUILD_LOCAL_LAB_ENABLED,
  location: Pick<Location, "hostname"> | undefined = browserVaultLocation(),
): PreferenceOverrides["vaultBackend"] {
  return availableVaultBackend(value, googleClientId, location, localLabEnabled)
    ?? (isDeployableGoogleOAuthClientId(googleClientId) ? "google-drive" : "ephemeral");
}

/**
 * ── The Durability row ───────────────────────────────────────────────────
 *
 * Every other row in Preferences chooses a rendering. This one chooses a
 * *destination for a person's data*, and it was printing that destination as
 * though it were the state of the world: "Encrypted Google Drive ·
 * cross-device", with no qualifier, while `#vault` two clicks away read
 * "Disconnected | No vault claim | No cloud vault is configured." One fact, two
 * surfaces, opposite answers — and the answer a person who never opens `#vault`
 * would carry away is that their workspace is encrypted in Drive when nothing
 * is attached.
 *
 * The fix is at the source rather than in either string: the row renders
 * selection *plus* state, so a selection can no longer read as an adoption.
 */
/**
 * Each destination, and what choosing it costs or buys, in one table.
 *
 * The consequence is the option's description rather than part of its label:
 * the label is also the collapsed trigger, and "Encrypted Google Driv…"
 * truncating with 210px of void beside it is what a four-word label buys.
 */
const DURABILITY: Readonly<Record<VaultBackend, readonly [destination: string, consequence: string]>> = Object.freeze({
  "local-device": Object.freeze(["This device", "Encrypted here. Not on your other devices."] as const),
  "google-drive": Object.freeze(["Google Drive", "Encrypted in your own Drive, on every device."] as const),
  "local-lab": Object.freeze(["Local MinIO lab", "A development adapter, not a place to keep anything."] as const),
  /*
   * "Nothing survives closing this tab" was not true, and this is the whole of
   * the correction.
   *
   * Content really does die with the tab: no title, no message, no digest ever
   * leaves page memory. But Airship keeps one line per conversation in this
   * browser — id, profile, message count, last-active time, posture — so a
   * return can say "something was not kept" instead of showing a blank screen
   * that looks like a first visit. That witness is a real change to the
   * contract, and stating "nothing survives" beside it made the product lie
   * about itself in the one place a privacy-first reader looks hardest.
   *
   * The posture is named for what it actually promises. The full disclosure is
   * `EPHEMERAL_RETENTION_DISCLOSURE`, and the Vault route carries an Erase
   * control so the witness is a choice rather than a condition.
   */
  ephemeral: Object.freeze(["Ephemeral content", "Your writing dies with the tab. One line per conversation stays, so a return can tell you."] as const),
});

/** Stock destinations, in the exact order both product selectors render. */
export const STOCK_VAULT_BACKENDS: readonly VaultBackend[] = Object.freeze([
  "ephemeral",
  "local-device",
  "google-drive",
] as const);

/** Recognized persisted values. `local-lab` is host-composed, not stock. */
export const VAULT_BACKENDS: readonly VaultBackend[] = Object.freeze([
  ...STOCK_VAULT_BACKENDS,
  "local-lab",
] as const);

/** The destinations this build and page origin may advertise in a selector. */
export function vaultBackendsForSelector(
  input: VaultBackendSelectorAvailability = {},
): readonly VaultBackend[] {
  const location = input.location ?? browserVaultLocation();
  const localLabEnabled = input.localLabEnabled ?? BUILD_LOCAL_LAB_ENABLED;
  const stock = STOCK_VAULT_BACKENDS.filter((backend) =>
    availableVaultBackend(backend, input.googleClientId, location, localLabEnabled));
  return Object.freeze([
    ...stock,
    ...(availableVaultBackend("local-lab", input.googleClientId, location, localLabEnabled)
      ? ["local-lab" as const]
      : []),
  ]);
}

/**
 * Whether the selected destination is actually holding anything.
 *
 * `undefined` is the honest third arm and the default: a host that does not
 * pass the vault's state has not established one, so the row states the
 * destination alone and claims nothing about adoption. It can only under-claim,
 * which is the only direction this row is allowed to be wrong in.
 */
export type DurabilityAdoption = "connected" | "not-connected" | undefined;

export function durabilityOptionLabel(backend: VaultBackend, adoption: DurabilityAdoption): string {
  const destination = DURABILITY[backend][0];
  // Page memory has no adoption axis: it is the absence of a vault, and
  // "Page memory only · not connected" would invent a failure out of a choice.
  if (backend === "ephemeral" || adoption === undefined) return destination;
  return `${destination} · ${adoption === "connected" ? "connected" : "not connected"}`;
}

/**
 * The row's helper sentence, in the state the row is actually in.
 *
 * `Tool steps` already gets a sentence like this. This row needs one more,
 * because it is the only value in the dialog that is a claim about the world.
 */
export type DurabilityOption = Readonly<{
  value: VaultBackend;
  label: string;
  description: string;
  disabled?: boolean;
}>;

/**
 * Settings uses the same filtered destination set as Vault.
 *
 * Unconfigured Drive and non-composed local MinIO remain recognizable values so
 * a historical selection can get an explicit refusal. They are not options in
 * the chooser and therefore are not advertised as disabled product rungs.
 */
export function durabilityOptions(input: Readonly<{
  selected: VaultBackend;
  adoption: DurabilityAdoption;
  /** Absent means the host reported no vault state; see `durabilityOptionLabel`. */
  vaultAdopted?: boolean;
  googleClientId?: string | null;
  localLabEnabled?: boolean;
  location?: Pick<Location, "hostname">;
}>): readonly DurabilityOption[] {
  return Object.freeze(vaultBackendsForSelector(input).map((backend) => {
    const adoption = backend === input.selected
      ? input.adoption
      : input.vaultAdopted === undefined ? undefined : "not-connected";
    return Object.freeze({
      value: backend,
      label: durabilityOptionLabel(backend, adoption),
      description: DURABILITY[backend][1],
    });
  }));
}

/** Why this deployment cannot reach a historical or requested destination. */
export function vaultBackendUnavailableReason(
  backend: VaultBackend,
  googleClientId?: string | null,
  location: Pick<Location, "hostname"> | undefined = browserVaultLocation(),
  localLabEnabled = BUILD_LOCAL_LAB_ENABLED,
): string | undefined {
  if (availableVaultBackend(backend, googleClientId, location, localLabEnabled)) return undefined;
  if (backend === "google-drive") return "Unavailable: this build has no Google OAuth client ID, so Drive authorization cannot be opened.";
  if (!localLabEnabled) return "Unavailable: this build does not include the host-composed local MinIO lab.";
  return "Unavailable: the local MinIO lab is reachable only from an exact loopback origin.";
}

export function durabilityRowNote(adoption: DurabilityAdoption): string {
  const purpose = "Where conversations survive a closed tab.";
  if (adoption === "connected") return `${purpose} Vault holds it, and can detach it.`;
  if (adoption === "not-connected") return `${purpose} Nothing is attached yet — set it up in Vault.`;
  return `${purpose} Vault states what is attached.`;
}

export const DEFAULT_PREFERENCES: PreferenceOverrides = Object.freeze({
  mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: resolveDefaultVaultBackend(import.meta.env.VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER, import.meta.env.VITE_GOOGLE_CLIENT_ID), approvalMode: "ask-first", transcriptOperations: DEFAULT_TRANSCRIPT_OPERATIONS,
});

const PREFERENCE_STORAGE_KEY = "airship.display-preferences.v1";

export function loadPreferenceOverrides(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
  availability: Readonly<{
    googleClientId?: string | null;
    defaultVaultBackend?: VaultBackend;
    localLabEnabled?: boolean;
    location?: Pick<Location, "hostname">;
  }> = {},
): PreferenceOverrides {
  if (!storage) return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(storage.getItem(PREFERENCE_STORAGE_KEY) ?? "null") as Partial<PreferenceOverrides> | null;
    if (!value) return DEFAULT_PREFERENCES;
    const googleClientId = "googleClientId" in availability
      ? availability.googleClientId
      : import.meta.env.VITE_GOOGLE_CLIENT_ID;
    const localLabEnabled = availability.localLabEnabled ?? BUILD_LOCAL_LAB_ENABLED;
    const location = availability.location ?? browserVaultLocation();
    const availableDefault = resolveDefaultVaultBackend(
      availability.defaultVaultBackend ?? DEFAULT_PREFERENCES.vaultBackend,
      googleClientId,
      localLabEnabled,
      location,
    );
    return Object.freeze({
      mode: value.mode === "light" ? "light" : "dark",
      typeScale: value.typeScale === "large" || value.typeScale === "x-large" ? value.typeScale : "default",
      density: value.density === "compact" ? "compact" : "comfortable",
      corners: value.corners === "square" || value.corners === "rounded" ? value.corners : "subtle",
      bodyFont: value.bodyFont === "system-serif" ? "system-serif" : "system-sans",
      vaultBackend: availableVaultBackend(value.vaultBackend, googleClientId, location, localLabEnabled) ?? availableDefault,
      approvalMode: value.approvalMode === "auto-approve" || value.approvalMode === "full-access" ? value.approvalMode : "ask-first",
      transcriptOperations: parseTranscriptOperationsMode(value.transcriptOperations),
    });
  } catch { return DEFAULT_PREFERENCES; }
}

export function savePreferenceOverrides(value: PreferenceOverrides, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try { storage?.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(value)); } catch { /* Display preferences remain live for this page. */ }
}

/**
 * The presentation layer a theme establishes under the preference layer.
 *
 * `typeScale` carries one more value than the preference enum because a theme
 * may ask for the compact ramp and no global preference can; the union here is
 * the complete vocabulary of `data-type-scale`, and every member of it has a
 * `--type-scale` block in tokens.css.
 */
export type PresentationDefaults = Readonly<{
  typeScale: PreferenceOverrides["typeScale"] | "compact";
  density: PreferenceOverrides["density"];
  corners: PreferenceOverrides["corners"];
  bodyFont: PreferenceOverrides["bodyFont"];
}>;

/** What the stylesheet renders when neither a theme nor a preference speaks. */
export const STYLESHEET_PRESENTATION_DEFAULTS: PresentationDefaults = Object.freeze({
  typeScale: DEFAULT_PREFERENCES.typeScale,
  density: DEFAULT_PREFERENCES.density,
  corners: DEFAULT_PREFERENCES.corners,
  bodyFont: DEFAULT_PREFERENCES.bodyFont,
});

export function applyPreferenceOverrides(
  value: PreferenceOverrides,
  root = document.documentElement,
  base: PresentationDefaults = STYLESHEET_PRESENTATION_DEFAULTS,
): void {
  root.dataset.mode = value.mode;
  /*
   * An override layer, not a rewrite. Writing all four unconditionally is what
   * made `ThemeManifest.typography` and `.layout` dead contract: the theme set
   * them and this layer overwrote them with its own defaults one statement
   * later, so no theme could ever change type, density, corners or body font.
   * A preference the user has not moved off default now resolves to whatever
   * the theme established. The resolved value is still always written, so
   * returning a preference *to* default cannot strand the previous override on
   * the element.
   */
  root.dataset.typeScale = value.typeScale === DEFAULT_PREFERENCES.typeScale ? base.typeScale : value.typeScale;
  root.dataset.density = value.density === DEFAULT_PREFERENCES.density ? base.density : value.density;
  root.dataset.corners = value.corners === DEFAULT_PREFERENCES.corners ? base.corners : value.corners;
  root.dataset.bodyFont = value.bodyFont === DEFAULT_PREFERENCES.bodyFont ? base.bodyFont : value.bodyFont;
  root.style.colorScheme = value.mode;
  syncDocumentThemeColor(root);
  // The transcript renderer sits below the prop tree that carries preferences,
  // so applying one is also how it becomes live there.
  setTranscriptOperationsMode(value.transcriptOperations);
}

/**
 * Puts the browser's own chrome on the palette the document actually resolved.
 *
 * `index.html` can only hard-code one colour, and it hard-coded the dark one:
 * a light-mode reader got a dark address bar and a dark overscroll gutter
 * around a paper document for the whole session. `--ground` is read back rather
 * than passed in so this is right for both callers — a theme has already
 * written its inline palette by the time it reaches here, and with no theme the
 * value is the mode's own stylesheet ground.
 */
function syncDocumentThemeColor(root: HTMLElement): void {
  if (typeof document === "undefined" || root !== document.documentElement) return;
  const ground = getComputedStyle(root).getPropertyValue("--ground").trim();
  if (!ground) return;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", ground);
}


export function approvalModeLabel(mode: ApprovalMode): string {
  if (mode === "auto-approve") return "Auto Approve";
  if (mode === "full-access") return "Full Access";
  return "Ask First";
}

export function approvalModeDescription(mode: ApprovalMode): string {
  if (mode === "auto-approve") return "Registered write effects run automatically inside their declared browser tool boundary. Execute, network, and identity effects still ask you. This mode makes no separate inference request.";
  if (mode === "full-access") return "Actions run without prompts, through the same explicit browser tools and schemas: workspace writes stay path-confined, but network and identity effects may contact any HTTPS origin that permits it, with no prompt.";
  return "Read-only actions proceed automatically; write, network, execute, and identity actions require one-time approval.";
}


/**
 * One claim, rendered in full: status mark, verbatim label, verbatim sentence, and the
 * route that owns the record.
 */
export type DetailRow = Readonly<{
  id: string;
  state: StatusMarkState;
  label: string;
  detail: string;
  /** Absent only for a claim with no route of its own; the row then states it without a target. */
  action?: Readonly<{ label: string; onSelect(): void }>;
}>;

export function DetailRows({ rows }: Readonly<{ rows: readonly DetailRow[] }>) {
  return <div class="detail-rows">{rows.map((row) => {
    const body = <><StatusMark state={row.state} label={row.label} detail={row.detail} /><small>{row.detail}</small>{row.action ? <span aria-hidden="true">→</span> : null}</>;
    return row.action
      ? <button key={row.id} type="button" onClick={row.action.onSelect}>{body}</button>
      : <p key={row.id}>{body}</p>;
  })}</div>;
}

type ViewBoundaryProps = { name: string; onRecover(): void; children: ComponentChildren };
type ViewBoundaryState = { error?: Error };
export class ViewErrorBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = {};
  static getDerivedStateFromError(error: Error): ViewBoundaryState { return { error }; }
  componentDidCatch(error: Error): void { console.error(`Airship ${this.props.name} view failed safely.`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <section class="view-error panel" role="alert"><StatusMark state="failed" label="View unavailable" detail={`${this.props.name} failed to render`} /><h1>{this.props.name} could not be displayed</h1><p>Your session and workspace were not changed. Recover to Chat and continue from a working surface.</p><button type="button" onClick={() => { this.setState({ error: undefined }); this.props.onRecover(); }}>Recover to Chat</button><details><summary>Technical details</summary><code>{this.state.error.message.slice(0, 500)}</code></details></section>;
  }
}

/**
 * Whether leaving this page would destroy work nothing can rebuild.
 *
 * The predicate used to be "a conversation exists", which is true from the
 * first frame of every visit: the dialog fired on every reload, on every
 * adopted-Vault runtime whose journal survives a reload intact, and on a
 * brand-new empty conversation. A confirmation that is always shown is a
 * confirmation nobody reads, so the one time it guards real loss it is
 * dismissed by reflex.
 *
 * The three real terms: a turn in flight can be lost mid-write; page-memory
 * events die with the tab; an adopted Vault has already written them down.
 * Unsent composer text is deliberately absent — it is mirrored into
 * `sessionStorage` per thread and rehydrates after a reload.
 */
export function unloadWouldLoseWork(input: Readonly<{
  /** A turn or storage transition is mid-flight. */
  busy: boolean;
  /** Durable events in the open conversation. */
  eventCount: number;
  /** The runtime writes through configured encrypted adapters. */
  vaultAdopted: boolean;
  /** Airship is performing this navigation itself; see `useBeforeUnloadGuard`. */
  reloading?: boolean;
}>): boolean {
  if (input.reloading) return false;
  if (input.busy) return true;
  return !input.vaultAdopted && input.eventCount > 0;
}

/**
 * Registers the guard and hands back the synchronous release.
 *
 * Separated from the hook because the suite runs without a DOM: this is the
 * whole behaviour, and the hook below is the three lines of lifecycle over it.
 */
export function armBeforeUnloadGuard(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
  target.addEventListener("beforeunload", guard);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    target.removeEventListener("beforeunload", guard);
  };
}

/**
 * Returns a release the caller invokes before navigating on purpose.
 *
 * A state flag cannot do this job: `window.location.reload()` runs in the same
 * tick as the click, long before a re-render could unregister the listener, so
 * pressing "Reload Airship" would still raise the browser's own "leave site?"
 * over a reload the person just asked for.
 */
export function useBeforeUnloadGuard(active: boolean): () => void {
  const release = useRef<() => void>();
  useEffect(() => {
    if (!active) return;
    const releaseGuard = armBeforeUnloadGuard(window);
    release.current = releaseGuard;
    return () => { release.current = undefined; releaseGuard(); };
  }, [active]);
  return () => { release.current?.(); release.current = undefined; };
}

/**
 * The trailing edge of a burst of values.
 *
 * Exported as a scheduler rather than buried in the hook for the same reason as
 * `armBeforeUnloadGuard`: this *is* the debounce, and `useEffect`'s contract is
 * exactly "run the previous cleanup, then this effect", so driving it directly
 * exercises the hook's semantics rather than a transcription of them.
 */
export function scheduleTrailingValue<T>(
  value: T,
  delayMs: number,
  commit: (value: T) => void,
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
): () => void {
  const handle = timers.setTimeout(() => commit(value), delayMs);
  return () => timers.clearTimeout(handle);
}

/**
 * `value` once it has stopped moving for `delayMs`.
 *
 * The initial value is adopted synchronously, so a first render is never
 * delayed by the window — only a *change* pays it.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => scheduleTrailingValue(value, delayMs, setSettled), [value, delayMs]);
  return settled;
}

/**
 * Publishes the obscured height and re-anchors a transcript that was already
 * riding its last card.
 *
 * The re-anchor belongs here because the soft keyboard moves the layout through
 * CSS alone: `--visual-viewport-bottom` shrinks `#app` to the visual viewport,
 * which raises the transcript's floor, and no Preact state changes — so the
 * transcript's own re-pin effect, which is keyed on messages and measured
 * heights, never re-runs. Without this, opening the keyboard leaves the reader
 * looking at the same pixels while the reply they just asked for scrolls out
 * of the shortened box.
 */
export function publishVisualViewportOffset(root: HTMLElement, obscured: number, scale = 1): void {
  // `visualViewport` reports pinch zoom through the same two numbers as a
  // keyboard: a shorter `height` and a moving `offsetTop`. So `obscured`
  // changes on every frame of a pinch-pan, and the "did the value move" test
  // below cannot tell the two apart — a zoomed reader got the transcript
  // scrolled under their own finger, and the shell shrunk around them. The
  // arithmetic is only a keyboard measurement at scale 1; above it, hold
  // whatever was last published rather than compensate for a gesture.
  if (Math.abs(scale - 1) > 0.01) return;
  const published = `${Math.round(obscured)}px`;
  if (root.style.getPropertyValue("--visual-viewport-bottom") === published) return;
  const transcript = root.querySelector<HTMLElement>(".transcript");
  // Ask before the offset lands. Once the shell shrinks, the container has
  // already drifted away from the last card and the answer is always "no".
  const anchored = transcript !== null && isNearLastRealCard(transcript);
  const floorBefore = transcript?.getBoundingClientRect().bottom;
  root.style.setProperty("--visual-viewport-bottom", published);
  root.dataset.keyboardOpen = obscured > 80 ? "true" : "false";
  if (!transcript || !anchored) return;
  // Follow the stylesheet instead of assuming it. Re-anchoring is only ever
  // correct as compensation for a floor that moved; when nothing in the
  // cascade consumes the variable at this width — every desktop layout, and
  // any future breakpoint that opts out — the card is still on the floor and
  // scrolling would move it off. This read is also what flushes the layout the
  // scroll target is then computed from.
  if (transcript.getBoundingClientRect().bottom === floorBefore) return;
  scrollToLastRealCard(transcript, "auto");
}

/** Publishes the obscured keyboard height without guessing on unsupported browsers. */
export function useVisualViewport(root = typeof document === "undefined" ? undefined : document.documentElement): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !root) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        publishVisualViewportOffset(root, Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop), viewport.scale);
      });
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--visual-viewport-bottom");
      delete root.dataset.keyboardOpen;
    };
  }, [root]);
}

export function usePwaUpdate(): Readonly<{ updateReady: boolean; reload(): void }> {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [updateReady, setUpdateReady] = useState(false);
  const reloadRequested = useRef(false);
  const userInteracted = useRef(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let current = true;
    const markInteraction = (event: Event) => { if (event.isTrusted) userInteracted.current = true; };
    const interactionEvents = ["pointerdown", "keydown", "beforeinput", "drop"] as const;
    interactionEvents.forEach((type) => window.addEventListener(type, markInteraction, true));
    const watch = (candidate: ServiceWorkerRegistration) => {
      if (!current) return;
      setRegistration(candidate);
      if (candidate.waiting) setUpdateReady(true);
      candidate.addEventListener("updatefound", () => {
        const worker = candidate.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) setUpdateReady(true);
        });
      });
    };
    void navigator.serviceWorker.getRegistration().then((candidate) => candidate && watch(candidate));
    const controllerChange = () => {
      /*
       * The first static-host takeover must establish COOP/COEP, but never
       * interrupt work a person has already started.
       *
       * "Started" used to mean a real input gesture, and that fence was too
       * narrow — J151. A conversation is minted before anyone types, and under
       * page memory it does not cross a reload, so the takeover could discard
       * a whole turn that had been rendered and reported complete. The gesture
       * is still honoured; `reloadWouldDiscardWork` adds the case where there
       * is state on this page that no authority could give back. Under an
       * adopted Vault it answers no however much has been said, because the
       * journal is on the far side of the reload — so the fast path a first
       * visit needs is untouched.
       */
      if (reloadRequested.current) { window.location.reload(); return; }
      if (userInteracted.current || reloadWouldDiscardWork(readReloadRisk())) setUpdateReady(true);
      else window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChange);
    return () => {
      current = false;
      interactionEvents.forEach((type) => window.removeEventListener(type, markInteraction, true));
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChange);
    };
  }, []);
  return Object.freeze({ updateReady, reload() { reloadRequested.current = true; if (registration?.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" }); else window.location.reload(); } });
}

export function PwaUpdateBanner({ updateReady, onReload }: Readonly<{ updateReady: boolean; onReload(): void }>) {
  // Hooks run unconditionally; the measurement idles until the banner is up.
  const floor = useBottomFloor(updateReady);
  if (!updateReady) return null;
  // J152: this banner used a constant bottom offset and landed on top of the
  // composer's send button — a `role="status"` div eating the click, measured
  // as 58 refused Playwright retries. `--pwa-update-floor` is the live height
  // of whatever holds the bottom edge, the same measurement the capability
  // dock has always used.
  return <div class="pwa-update" role="status" style={{ "--pwa-update-floor": `${floor}px` }}><span><strong>Runtime update ready</strong><small>Your current work stays active until you choose to reload.</small></span><button type="button" onClick={onReload}>Reload Airship</button></div>;
}

/**
 * Rank for the *unfiltered* list only. A typed query is answered by relevance
 * to what was typed, and this must not reorder it.
 */
const PALETTE_RECALL_RANK: Readonly<Record<PaletteEntry["group"], number>> = Object.freeze({
  Sessions: 0, Actions: 1, Navigate: 2, Setup: 2, Preferences: 3, Commands: 4,
});

export function filterPaletteEntries(entries: readonly PaletteEntry[], query: string): readonly PaletteEntry[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  /*
   * With nothing typed, the palette's question is "take me back to what I was
   * doing" — so the conversations answer it.
   *
   * Measured: the placeholder said "Go to a view, session, or command…" and the
   * unfiltered list was 15 destinations then ~36 slash commands, with the
   * session rows the palette already builds below all of them. `⌘K ↵` could not
   * return a person to their own thread, and finding one at all was gated
   * behind guessing its title. Sort is stable, so within a group the order the
   * builder chose — recency for sessions — survives.
   */
  if (!terms.length) {
    return [...entries]
      .sort((left, right) => PALETTE_RECALL_RANK[left.group] - PALETTE_RECALL_RANK[right.group])
      .slice(0, 40);
  }
  return entries.filter((entry) => {
    const haystack = [entry.label, entry.description, entry.group, ...(entry.keywords ?? [])].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, 40);
}

function scopeLabel(scope: string): string { return `${scope[0]?.toUpperCase()}${scope.slice(1)} scope`; }
function shortId(id: string): string { return id.length > 12 ? `${id.slice(0, 8)}…` : id; }
export function safeId(id: string): string { return id.replace(/[^a-z0-9_-]/giu, "-"); }
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName));
}
