import { Component, type ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SlashCommandDescriptor } from "../commands/types";
import type { SessionListItem } from "../sessions/domain";
import { CANONICAL_DESTINATIONS, SETTINGS_OVERLAY_ENTRY, type NavigationView } from "./navigation-model";
import { Seal, type SealState } from "./seal";
import { trapFocus } from "./focus-trap";
import type { ApprovalMode } from "../approvals/modes";
import { MenuSelect } from "./menu-select";
import { isDeployableGoogleOAuthClientId } from "../storage/google-drive-configuration";
import {
  DEFAULT_TRANSCRIPT_OPERATIONS,
  parseTranscriptOperationsMode,
  setTranscriptOperationsMode,
  type TranscriptOperationsMode,
} from "./chat/transcript-operations";

export type PaletteEntry = Readonly<{
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  group: "Navigate" | "Commands" | "Sessions" | "Trust" | "Preferences";
  run(): void;
}>;

export function buildPaletteEntries(args: Readonly<{
  navigate(view: NavigationView): void;
  openPreferences(): void;
  commands?: readonly SlashCommandDescriptor[];
  runCommand?(command: string): void;
  sessions?: readonly Readonly<{ id: string; title: string; open(): void }>[];
}>): readonly PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const destination of CANONICAL_DESTINATIONS) {
    entries.push(Object.freeze({
      id: `view:${destination.id}`,
      label: destination.label,
      description: `${destination.group} · ${scopeLabel(destination.scope)}`,
      keywords: [destination.id, destination.hash, destination.group, destination.scope],
      group: destination.group === "Trust" ? "Trust" : "Navigate",
      run: () => args.navigate(destination.id),
    }));
    for (const nested of destination.nested) entries.push(Object.freeze({
      id: `view:${nested.id}`,
      label: nested.label,
      description: `${destination.label} · ${scopeLabel(nested.scope)}`,
      keywords: [nested.id, nested.hash, destination.label],
      group: destination.group === "Trust" ? "Trust" : "Navigate",
      run: () => args.navigate(nested.id),
    }));
  }
  entries.push(Object.freeze({
    id: SETTINGS_OVERLAY_ENTRY.id,
    label: "Preferences",
    description: "Display, storage, and browser-agent approvals",
    keywords: ["settings", "theme", "mode", "paper", "dark", "approval", "full access", "auto approve"],
    group: "Preferences",
    run: args.openPreferences,
  }));
  for (const command of args.commands ?? []) entries.push(Object.freeze({
    id: `command:${command.name}`,
    label: `/${command.name}`,
    description: command.availability.enabled ? command.summary : command.availability.reason ?? "Unavailable",
    keywords: [...command.aliases, command.category, command.usage],
    group: "Commands",
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

export function CommandPalette({ open, entries, onClose }: Readonly<{
  open: boolean;
  entries: readonly PaletteEntry[];
  onClose(): void;
}>) {
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement>();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = useMemo(() => filterPaletteEntries(entries, query), [entries, query]);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setQuery("");
    setActive(0);
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      restore.current?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };
  return (
    <div class="platform-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialog}
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          else if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(filtered.length - 1, value + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); choose(filtered[active]); }
          else if (event.key === "Tab") trapFocus(event, dialog.current);
        }}
      >
        <h2 id="command-palette-title" class="sr-only">Airship command palette</h2>
        <div class="command-palette__search">
          <span aria-hidden="true">⌘</span>
          <input ref={input} value={query} role="combobox" aria-controls="command-palette-results" aria-expanded="true" aria-activedescendant={filtered[active] ? `palette-${safeId(filtered[active]!.id)}` : undefined} placeholder="Go to a view, session, or command…" onInput={(event) => { setQuery(event.currentTarget.value); setActive(0); }} />
          <kbd>Esc</kbd>
        </div>
        <div id="command-palette-results" class="command-palette__results" role="listbox">
          {filtered.length ? filtered.map((entry, index) => (
            <button id={`palette-${safeId(entry.id)}`} key={entry.id} type="button" role="option" aria-selected={index === active} class={index === active ? "is-active" : ""} onMouseEnter={() => setActive(index)} onClick={() => choose(entry)}>
              <span><strong>{entry.label}</strong><small>{entry.description}</small></span><em>{entry.group}</em>
            </button>
          )) : <p class="command-palette__empty">No matching destination or command.</p>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> open</span></footer>
      </div>
    </div>
  );
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
  c: "chat", s: "sessions", w: "workspace", m: "memory", x: "context", p: "profiles", t: "proof", n: "access",
});

export function navigationJumpForChord(prefix: string | undefined, key: string): NavigationView | undefined {
  return prefix === "g" ? NAVIGATION_JUMPS[key.toLocaleLowerCase()] : undefined;
}

export function useGlobalNavigationJumps(navigate: (view: NavigationView) => void): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    let prefix: string | undefined;
    let timeout = 0;
    const clear = () => { prefix = undefined; window.clearTimeout(timeout); timeout = 0; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) { clear(); return; }
      if (!prefix && event.key.toLocaleLowerCase() === "g") {
        prefix = "g";
        timeout = window.setTimeout(clear, 900);
        return;
      }
      const destination = navigationJumpForChord(prefix, event.key);
      clear();
      if (!destination) return;
      event.preventDefault();
      navigateRef.current(destination);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { clear(); window.removeEventListener("keydown", onKeyDown); };
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
   * Google Drive transport; Local Device is the safe deployable fallback,
   * local MinIO remains a development adapter, and ephemeral stays page-only.
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

function availableVaultBackend(
  value: unknown,
  googleClientId?: string | null,
): VaultBackend | undefined {
  if (value === "google-drive") {
    return isDeployableGoogleOAuthClientId(googleClientId) ? value : undefined;
  }
  return value === "local-device" || value === "local-lab" || value === "ephemeral"
    ? value
    : undefined;
}

export function resolveDefaultVaultBackend(
  value: string | undefined,
  googleClientId?: string | null,
): PreferenceOverrides["vaultBackend"] {
  return availableVaultBackend(value, googleClientId)
    ?? (isDeployableGoogleOAuthClientId(googleClientId) ? "google-drive" : "local-device");
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
  }> = {},
): PreferenceOverrides {
  if (!storage) return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(storage.getItem(PREFERENCE_STORAGE_KEY) ?? "null") as Partial<PreferenceOverrides> | null;
    if (!value) return DEFAULT_PREFERENCES;
    const googleClientId = "googleClientId" in availability
      ? availability.googleClientId
      : import.meta.env.VITE_GOOGLE_CLIENT_ID;
    const availableDefault = resolveDefaultVaultBackend(
      availability.defaultVaultBackend ?? DEFAULT_PREFERENCES.vaultBackend,
      googleClientId,
    );
    return Object.freeze({
      mode: value.mode === "light" ? "light" : "dark",
      typeScale: value.typeScale === "large" || value.typeScale === "x-large" ? value.typeScale : "default",
      density: value.density === "compact" ? "compact" : "comfortable",
      corners: value.corners === "square" || value.corners === "rounded" ? value.corners : "subtle",
      bodyFont: value.bodyFont === "system-serif" ? "system-serif" : "system-sans",
      vaultBackend: availableVaultBackend(value.vaultBackend, googleClientId) ?? availableDefault,
      approvalMode: value.approvalMode === "auto-approve" || value.approvalMode === "full-access" ? value.approvalMode : "ask-first",
      transcriptOperations: parseTranscriptOperationsMode(value.transcriptOperations),
    });
  } catch { return DEFAULT_PREFERENCES; }
}

export function savePreferenceOverrides(value: PreferenceOverrides, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try { storage?.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(value)); } catch { /* Display preferences remain live for this page. */ }
}

export function applyPreferenceOverrides(value: PreferenceOverrides, root = document.documentElement): void {
  root.dataset.mode = value.mode;
  root.dataset.typeScale = value.typeScale;
  root.dataset.density = value.density;
  root.dataset.corners = value.corners;
  root.dataset.bodyFont = value.bodyFont;
  root.style.colorScheme = value.mode;
  // The transcript renderer sits below the prop tree that carries preferences,
  // so applying one is also how it becomes live there.
  setTranscriptOperationsMode(value.transcriptOperations);
}

export function PreferencesDialog({ open, value, onChange, onClose, profileApproval, vaultProviderSwitching = false }: Readonly<{
  open: boolean;
  value: PreferenceOverrides;
  onChange(value: PreferenceOverrides): void;
  onClose(): void;
  vaultProviderSwitching?: boolean;
  profileApproval?: Readonly<{
    mode: ApprovalMode;
    onManage(): void;
  }>;
}>) {
  const dialog = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement>();
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(frame); restore.current?.focus({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  const update = <K extends keyof PreferenceOverrides>(key: K, next: PreferenceOverrides[K]) => onChange(Object.freeze({ ...value, [key]: next }));
  return (
    <div class="platform-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} class="preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="preferences-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") onClose(); else if (event.key === "Tab") trapFocus(event, dialog.current); }}>
        <header><div><span class="eyebrow">Runtime controls</span><h2 id="preferences-title">Preferences</h2><p>Change presentation and durability. Agent behavior remains pinned to its profile.</p></div><button type="button" onClick={onClose}>Done</button></header>
        {profileApproval ? <div class="profile-approval-preference">
          <div><span>Active profile approvals</span><strong>{approvalModeLabel(profileApproval.mode)}</strong></div>
          <button type="button" onClick={profileApproval.onManage}>Manage in Profiles</button>
          <p>{approvalModeDescription(profileApproval.mode)} A saved change creates a new profile revision and takes effect in a new pinned conversation.</p>
        </div> : <>
          <PreferenceSelect label="Legacy session approvals" value={value.approvalMode} options={[["ask-first","Ask First · prompt before effects"],["auto-approve","Auto Approve · model safety review"],["full-access","Full Access · bounded browser sandbox"]]} onChange={(next) => update("approvalMode", next as PreferenceOverrides["approvalMode"])} />
          <p><strong>{approvalModeLabel(value.approvalMode)}.</strong> {approvalModeDescription(value.approvalMode)}</p>
        </>}
        <PreferenceSelect label="Color mode" value={value.mode} options={[['dark','Dark instrument'],['light','Paper']]} onChange={(next) => update("mode", next as PreferenceOverrides["mode"])} />
        <PreferenceSelect label="Type scale" value={value.typeScale} options={[['default','Default'],['large','Large'],['x-large','Extra large']]} onChange={(next) => update("typeScale", next as PreferenceOverrides["typeScale"])} />
        <PreferenceSelect label="Density" value={value.density} options={[['comfortable','Comfortable'],['compact','Compact']]} onChange={(next) => update("density", next as PreferenceOverrides["density"])} />
        <PreferenceSelect label="Corners" value={value.corners} options={[['subtle','Subtle'],['square','Square'],['rounded','Rounded']]} onChange={(next) => update("corners", next as PreferenceOverrides["corners"])} />
        <PreferenceSelect label="Tool steps" value={value.transcriptOperations} options={[['summary','Summary'],['rows','Every step']]} onChange={(next) => update("transcriptOperations", next as PreferenceOverrides["transcriptOperations"])} />
        <p>A folded run still states how many steps ran, which tools ran them and how they ended. A failed or denied step is never folded.</p>
        <PreferenceSelect label="Body font" value={value.bodyFont} options={[['system-sans','System sans'],['system-serif','System serif']]} onChange={(next) => update("bodyFont", next as PreferenceOverrides["bodyFont"])} />
        <PreferenceSelect label="Durability" value={value.vaultBackend} disabled={vaultProviderSwitching} options={[['local-device','Encrypted Local Device · offline'],['google-drive','Encrypted Google Drive · cross-device'],['local-lab','Encrypted S3 · local MinIO lab'],['ephemeral','Ephemeral · page memory only']]} onChange={(next) => update("vaultBackend", next as PreferenceOverrides["vaultBackend"])} />
        <button class="preferences-dialog__reset" type="button" onClick={() => onChange(DEFAULT_PREFERENCES)}>Reset preferences</button>
      </div>
    </div>
  );
}

export function approvalModeLabel(mode: ApprovalMode): string {
  if (mode === "auto-approve") return "Auto Approve";
  if (mode === "full-access") return "Full Access";
  return "Ask First";
}

export function approvalModeDescription(mode: ApprovalMode): string {
  if (mode === "auto-approve") return "A separate tool-free model inference must return a valid safe verdict; unsafe actions are denied and indeterminate reviews fall back to asking you.";
  if (mode === "full-access") return "Actions run without prompts, but only through the same explicit browser tools, schemas, path confinement, and network boundaries.";
  return "Read-only actions proceed automatically; write, network, execute, and identity actions require one-time approval.";
}

function PreferenceSelect({ label, value, options, onChange, disabled = false }: Readonly<{ label: string; value: string; options: readonly (readonly [string,string])[]; onChange(value: string): void; disabled?: boolean }>) {
  return <div class="preference-row"><span>{label}</span><MenuSelect className="preference-menu" ariaLabel={label} value={value} disabled={disabled} options={options.map(([id, name]) => ({ value: id, label: name }))} onChange={onChange} /></div>;
}

export type TrustAxis = Readonly<{ id: "local" | "vault" | "e2ee" | "attestation"; label: string; state: SealState; detail: string; view: NavigationView }>;

const TRUST_STATE_SEVERITY: Readonly<Record<SealState, number>> = Object.freeze({
  failed: 7, attention: 6, stale: 5, asserted: 4, none: 3, checking: 2, verified: 1,
});

/** Returns the weakest independently-scoped claim without merging its semantics. */
export function worstTrustAxis(axes: readonly TrustAxis[]): TrustAxis | undefined {
  return axes.reduce<TrustAxis | undefined>((worst, candidate) =>
    !worst || TRUST_STATE_SEVERITY[candidate.state] > TRUST_STATE_SEVERITY[worst.state] ? candidate : worst,
  undefined);
}

/**
 * One claim, rendered in full: seal, verbatim label, verbatim sentence, and the
 * route that owns the record. This is the body of every level-1 disclosure in
 * the product — the runtime trust sheet and the chat session-status popover
 * render the same rows from different scopes, so a claim reads identically
 * wherever the user reaches it.
 */
export type ClaimRow = Readonly<{
  id: string;
  state: SealState;
  label: string;
  detail: string;
  /** Absent only for a claim with no route of its own; the row then states it without a target. */
  action?: Readonly<{ label: string; onSelect(): void }>;
}>;

export function ClaimRows({ rows }: Readonly<{ rows: readonly ClaimRow[] }>) {
  return <div class="claim-rows">{rows.map((row) => {
    const body = <><Seal state={row.state} label={row.label} detail={row.detail} /><small>{row.detail}</small>{row.action ? <span aria-hidden="true">→</span> : null}</>;
    return row.action
      ? <button key={row.id} type="button" onClick={row.action.onSelect}>{body}</button>
      : <p key={row.id}>{body}</p>;
  })}</div>;
}

export function TrustPostureSheet({ open, axes, onClose, onNavigate }: Readonly<{ open: boolean; axes: readonly TrustAxis[]; onClose(): void; onNavigate(view: NavigationView): void }>) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true })); }, [open]);
  if (!open) return null;
  return <div class="platform-scrim trust-sheet-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={dialog} class="trust-sheet" role="dialog" aria-modal="true" aria-labelledby="trust-sheet-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") onClose(); else if (event.key === "Tab") trapFocus(event, dialog.current); }}><header><div><span class="eyebrow">Four-axis posture</span><h2 id="trust-sheet-title">Runtime trust</h2></div><button type="button" onClick={onClose}>Close</button></header><p>Each axis is independently scoped. The weakest claim is shown in the topbar.</p><ClaimRows rows={axes.map((axis) => Object.freeze({ id: axis.id, state: axis.state, label: axis.label, detail: axis.detail, action: Object.freeze({ label: axis.label, onSelect: () => { onClose(); onNavigate(axis.view); } }) }))} /></div></div>;
}

const TRUST_TABS: readonly Readonly<{ view: NavigationView; label: string }>[] = Object.freeze([
  { view: "proof", label: "Proof" },
  { view: "vault", label: "Vault" }, { view: "access", label: "Connection" }, { view: "billing", label: "Account" },
]);

export function TrustHubTabs({ view, onNavigate }: Readonly<{ view: NavigationView; onNavigate(view: NavigationView): void }>) {
  const tabs = useRef<HTMLElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = tabs.current;
      const active = container?.querySelector<HTMLElement>("[aria-current='page']");
      if (!container || !active) return;
      const centered = active.offsetLeft + active.offsetWidth / 2 - container.clientWidth / 2;
      const maximum = Math.max(0, container.scrollWidth - container.clientWidth);
      container.scrollTo({ left: Math.max(0, Math.min(centered, maximum)), behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  return <nav ref={tabs} class="trust-hub-tabs" aria-label="Trust hub, four horizontally scrollable views">{TRUST_TABS.map((tab) => <button key={tab.view} type="button" class={view === tab.view ? "is-active" : ""} aria-current={view === tab.view ? "page" : undefined} onClick={() => onNavigate(tab.view)}>{tab.label}</button>)}</nav>;
}

type ViewBoundaryProps = { name: string; onRecover(): void; children: ComponentChildren };
type ViewBoundaryState = { error?: Error };
export class ViewErrorBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = {};
  static getDerivedStateFromError(error: Error): ViewBoundaryState { return { error }; }
  componentDidCatch(error: Error): void { console.error(`Airship ${this.props.name} view failed safely.`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <section class="view-error panel" role="alert"><Seal state="failed" label="View unavailable" detail={`${this.props.name} failed to render`} /><h1>{this.props.name} could not be displayed</h1><p>Your session and workspace were not changed. Recover to Chat and continue from a working surface.</p><button type="button" onClick={() => { this.setState({ error: undefined }); this.props.onRecover(); }}>Recover to Chat</button><details><summary>Technical details</summary><code>{this.state.error.message.slice(0, 500)}</code></details></section>;
  }
}

export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [active]);
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
        const obscured = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        root.style.setProperty("--visual-viewport-bottom", `${Math.round(obscured)}px`);
        root.dataset.keyboardOpen = obscured > 80 ? "true" : "false";
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
      // The first static-host takeover must establish COOP/COEP, but never
      // interrupt work a person has already started. A page that observed a
      // trusted input gesture keeps running and offers the explicit reload.
      if (!reloadRequested.current && userInteracted.current) setUpdateReady(true);
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
  if (!updateReady) return null;
  return <div class="pwa-update" role="status"><span><strong>Runtime update ready</strong><small>Your current work stays active until you choose to reload.</small></span><button type="button" onClick={onReload}>Reload Airship</button></div>;
}

export function filterPaletteEntries(entries: readonly PaletteEntry[], query: string): readonly PaletteEntry[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return entries.slice(0, 40);
  return entries.filter((entry) => {
    const haystack = [entry.label, entry.description, entry.group, ...(entry.keywords ?? [])].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, 40);
}

function scopeLabel(scope: string): string { return `${scope[0]?.toUpperCase()}${scope.slice(1)} scope`; }
function shortId(id: string): string { return id.length > 12 ? `${id.slice(0, 8)}…` : id; }
function safeId(id: string): string { return id.replace(/[^a-z0-9_-]/giu, "-"); }
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName));
}
