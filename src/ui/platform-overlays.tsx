import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApprovalMode } from "../approvals/modes";
import { trapFocus } from "./focus-trap";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { ConfirmDialog } from "./confirm-dialog";
import {
  DEFAULT_PREFERENCES,
  SHORTCUT_SHEET_CHORD,
  VAULT_BACKENDS,
  approvalModeDescription,
  approvalModeLabel,
  durabilityOptions,
  durabilityRowNote,
  filterPaletteEntries,
  safeId,
  useOpenerRestore,
  vaultBackendUnavailableReason,
  type DurabilityAdoption,
  type PaletteEntry,
  type PreferenceOverrides,
} from "./platform-shell";

/**
 * The two overlays that are never on screen at first paint.
 *
 * They lived in `platform-shell.tsx`, which the boot path imports for its hooks,
 * so 177 lines of dense dialog JSX shipped in the entry chunk to be rendered by
 * nobody. Entry gzip had 20 bytes of headroom under its 112 KiB ceiling and then
 * breached it at 112.01 KiB, and review was right that a budget a symbol rename
 * can breach is not a budget. Moving them here lets Rollup split them out; the
 * shell loads the chunk on idle after first paint, so the first Cmd+K is warm
 * and the ceiling gets a real margin back rather than a raise.
 */

export function CommandPalette({ open, entries, onClose, onOpenShortcuts }: Readonly<{
  open: boolean;
  entries: readonly PaletteEntry[];
  onClose(): void;
  /** The palette's footer teaches the sheet; without it the footer says nothing about it. */
  onOpenShortcuts?(): void;
}>) {
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = useMemo(() => filterPaletteEntries(entries, query), [entries, query]);

  useOpenerRestore(open);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;
  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    /*
     * An unavailable entry is announced, not enacted: the palette used to
     * close on activation and do nothing, which read as "ran, and nothing
     * happened". Keep it open with the row's reason still in view — the same
     * refusal `MenuSelect` gives a disabled option, where the control stays
     * up and the description carries the why.
     */
    if (entry.disabled) return;
    onClose();
    entry.run();
  };
  /*
   * The input owns this listbox through `aria-activedescendant`, so DOM focus
   * stays there while the active option moves. Handling the composite keys from
   * the dialog made Enter on the footer's real buttons open whichever result
   * happened to be highlighted instead.
   */
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
          else if (event.key === "Tab") trapFocus(event, dialog.current);
          else if (event.target === input.current) {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(filtered.length - 1, value + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
            else if (event.key === "Enter") { event.preventDefault(); choose(filtered[active]); }
          }
        }}
      >
        <h2 id="command-palette-title" class="sr-only">Airship command palette</h2>
        <div class="command-palette__search">
          <span aria-hidden="true">⌘</span>
          <input ref={input} value={query} role="combobox" aria-autocomplete="list" aria-controls="command-palette-results" aria-expanded="true" aria-activedescendant={filtered[active] ? `palette-${safeId(filtered[active]!.id)}` : undefined} placeholder="Go to a view, session, or command…" onInput={(event) => { setQuery(event.currentTarget.value); setActive(0); }} />
          <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{filtered.length
            ? `${filtered.length} result${filtered.length === 1 ? "" : "s"} available.`
            : "No matching destination or command."}</p>
          <span class="command-palette__dismiss">
            <kbd>Esc</kbd>
            <button type="button" aria-label="Close command palette" onClick={onClose}>Close</button>
          </span>
        </div>
        <div id="command-palette-results" class="command-palette__results" role="listbox">
          {filtered.map((entry, index) => (
            <button id={`palette-${safeId(entry.id)}`} key={entry.id} type="button" role="option" tabIndex={-1} aria-selected={index === active} aria-disabled={entry.disabled || undefined} class={index === active ? "is-active" : ""} onMouseEnter={() => setActive(index)} onClick={() => choose(entry)}>
              <span><strong>{entry.label}</strong><small>{entry.description}</small></span><em>{entry.group}</em>
            </button>
          ))}
        </div>
        {!filtered.length ? <p class="command-palette__empty" aria-hidden="true">No matching destination or command.</p> : null}
        {/* The footer printed only how to drive the palette, on the one surface
            in the product that could have taught the eleven chords outside it. */}
        <footer>
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>↵</kbd> open</span>
          {onOpenShortcuts ? (
            <button class="command-palette__shortcuts" type="button" onClick={() => { onClose(); onOpenShortcuts(); }}>
              <kbd>{SHORTCUT_SHEET_CHORD}</kbd> all shortcuts
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export function PreferencesDialog({ open, value, onChange, onClose, profileApproval, vaultProviderSwitching = false, vaultAdopted }: Readonly<{
  open: boolean;
  value: PreferenceOverrides;
  onChange(value: PreferenceOverrides): void;
  onClose(): void;
  vaultProviderSwitching?: boolean;
  /**
   * Whether the selected backend is holding anything right now, read from the
   * same vault snapshot `#vault` renders from. Optional because absence is the
   * one safe default: without it the Durability row states the destination and
   * asserts nothing about adoption.
   */
  vaultAdopted?: boolean;
  profileApproval?: Readonly<{
    mode: ApprovalMode;
    onManage(): void;
  }>;
}>) {
  const dialog = useRef<HTMLDivElement>(null);
  const [resetArmed, setResetArmed] = useState(false);
  /*
   * Whether the sheet has been scrolled off its first pixel, which is the only
   * thing CSS cannot ask about itself.
   *
   * Capped to a bottom sheet the header is held so "Done" cannot scroll away,
   * and holding it pins its eyebrow and description too — 135px of a 477px
   * sheet at phone-320, 101px of a 361px sheet at landscape-932, permanently,
   * for prose introducing a dialog the reader is already inside. The stylesheet
   * collapses that introduction under `.is-scrolled`; this is where the fact
   * comes from. The threshold is 2px rather than 0 so a sub-pixel scroll offset
   * cannot sit on the boundary and flip the class back and forth.
   */
  const [scrolled, setScrolled] = useState(false);
  // Same defect and the same fix as the palette: the `document.activeElement`
  // capture here ran a commit too late and could only ever read `<body>`.
  useOpenerRestore(open);
  useEffect(() => {
    if (!open) return;
    // Closing unmounts the dialog, so a reopened one is back at scrollTop 0 with
    // no scroll event to say so. Without this reset it would reopen collapsed.
    setScrolled(false);
    const frame = requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;
  const update = <K extends keyof PreferenceOverrides>(key: K, next: PreferenceOverrides[K]) => onChange(Object.freeze({ ...value, [key]: next }));
  /*
   * Page memory is not an adoption question: choosing it *is* the state, and
   * a host that reports no vault state leaves this `undefined` so the row can
   * only under-claim.
   */
  const adoption: DurabilityAdoption = value.vaultBackend === "ephemeral" || vaultAdopted === undefined
    ? undefined
    : vaultAdopted ? "connected" : "not-connected";
  const durabilityUnavailable = vaultBackendUnavailableReason(
    value.vaultBackend,
    import.meta.env.VITE_GOOGLE_CLIENT_ID,
    typeof window === "undefined" ? undefined : window.location,
  );
  return (
    <div class="platform-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} class={scrolled ? "preferences-dialog is-scrolled" : "preferences-dialog"} role="dialog" aria-modal="true" aria-labelledby="preferences-title" tabIndex={-1} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)} onKeyDown={(event) => { if (event.key === "Escape") { if (!event.defaultPrevented) onClose(); } else if (event.key === "Tab") trapFocus(event, dialog.current); }}>
        <header><div><span class="eyebrow">Runtime controls</span><h2 id="preferences-title">Preferences</h2><p>Change presentation and durability. Agent behavior remains pinned to its profile.</p></div><button type="button" onClick={onClose}>Done</button></header>
        {profileApproval ? <div class="profile-approval-preference">
          <div><span>Active profile approvals</span><strong>{approvalModeLabel(profileApproval.mode)}</strong></div>
          <button type="button" onClick={profileApproval.onManage}>Manage in Profiles</button>
          <p>{approvalModeDescription(profileApproval.mode)} A saved change creates a new profile revision and takes effect in a new pinned conversation.</p>
        </div> : <>
          <PreferenceSelect label="Legacy session approvals" value={value.approvalMode} options={[["ask-first","Ask First · prompt before effects"],["auto-approve","Auto Approve · writes only; stronger effects ask"],["full-access","Full Access · no prompts, any HTTPS origin"]]} onChange={(next) => update("approvalMode", next as PreferenceOverrides["approvalMode"])} />
          <p><strong>{approvalModeLabel(value.approvalMode)}.</strong> {approvalModeDescription(value.approvalMode)}</p>
        </>}
        <PreferenceSelect
          label="Color mode"
          value={value.mode}
          options={[["dark", "Dark instrument"], ["light", "Paper"]]}
          leading={(mode) => <Icon name={mode === "dark" ? "moon" : "sun"} size={17} />}
          onChange={(next) => update("mode", next as PreferenceOverrides["mode"])}
        />
        <PreferenceSelect label="Type scale" value={value.typeScale} options={[['default','Default'],['large','Large'],['x-large','Extra large']]} onChange={(next) => update("typeScale", next as PreferenceOverrides["typeScale"])} />
        <PreferenceSelect label="Density" value={value.density} options={[['comfortable','Comfortable'],['compact','Compact']]} onChange={(next) => update("density", next as PreferenceOverrides["density"])} />
        <PreferenceSelect label="Corners" value={value.corners} options={[['subtle','Subtle'],['square','Square'],['rounded','Rounded']]} onChange={(next) => update("corners", next as PreferenceOverrides["corners"])} />
        <PreferenceSelect label="Tool steps" value={value.transcriptOperations} options={[['summary','Summary'],['rows','Every step']]} onChange={(next) => update("transcriptOperations", next as PreferenceOverrides["transcriptOperations"])} />
        <p>A folded run still states how many steps ran, which tools ran them and how they ended. A failed or denied step is never folded.</p>
        <PreferenceSelect label="Body font" value={value.bodyFont} options={[['system-sans','System sans'],['system-serif','System serif']]} onChange={(next) => update("bodyFont", next as PreferenceOverrides["bodyFont"])} />
        {/*
          Under its own divider, so a claim about where a person's data lives is
          not read as the ninth in a run of presentation rows.
        */}
        <p class="preferences-dialog__divider">Storage</p>
        <PreferenceSelect
          label="Durability"
          // The last row in a scrolling dialog. Down is where the room is not.
          placement="up"
          value={value.vaultBackend}
          disabled={vaultProviderSwitching}
          options={durabilityOptions({
            selected: value.vaultBackend,
            adoption,
            ...(vaultAdopted === undefined ? {} : { vaultAdopted }),
            googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
            ...(typeof window === "undefined" ? {} : { location: window.location }),
          }).map((option) => [option.value, option.label, option.description, option.disabled ?? false] as const)}
          onChange={(next) => update("vaultBackend", next as PreferenceOverrides["vaultBackend"])}
        />
        <p role={durabilityUnavailable ? "alert" : undefined}>{durabilityUnavailable ?? durabilityRowNote(adoption)}</p>
        <button
          class="preferences-dialog__reset"
          type="button"
          onClick={() => setResetArmed(true)}
        >Reset preferences</button>
        {resetArmed ? (
          <ConfirmDialog
            title="Reset preferences?"
            confirmLabel="Reset to defaults"
            onCancel={() => setResetArmed(false)}
            onConfirm={() => {
              setResetArmed(false);
              // The storage destination survives the reset, because the host's
              // `onChange` is not a state write: a `vaultBackend` that differs
              // from the current one starts a real provider transition, which
              // detaches the adopted Vault and re-adopts the runtime into page
              // memory. A whole-object write of the defaults therefore made
              // "Reset preferences" disconnect the vault the sentence below
              // promises it will not touch — and it bypassed the Durability row,
              // which is the surface that owns the feasibility check and the
              // disabled-while-switching state a provider change needs.
              onChange(Object.freeze({ ...DEFAULT_PREFERENCES, vaultBackend: value.vaultBackend }));
            }}
          >
            <>
              Display and legacy approval preferences return to their defaults.
              Durability stays where you set it; change it in the Storage row above.
              Your conversations, profiles, vault, and workspaces are not touched — nothing
              outside this dialog changes.
            </>
          </ConfirmDialog>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Placement is a prop, and it is not cosmetic.
 *
 * The sheet used to be forced downward by a stylesheet override while
 * `MenuSelect` still believed it was placed upward, so neither the component's
 * fit measurement nor its own geometry applied: the last row in a scrolling
 * dialog opened a list that ran 25px past the bottom of the window and was
 * clipped by the dialog's own scroll box 78px before that. `down` is right for
 * a row with the whole dialog beneath it and measures the room it has; a row in
 * the lower third opens upward instead, where the room actually is.
 */
function PreferenceSelect({ label, value, options, onChange, disabled = false, placement = "down", leading }: Readonly<{ label: string; value: string; options: readonly (readonly [string, string] | readonly [string, string, string] | readonly [string, string, string, boolean])[]; onChange(value: string): void; disabled?: boolean; placement?: "up" | "down"; leading?(value: string): ComponentChildren }>) {
  // The fourth member is per-option availability, passed straight through:
  // `MenuSelect` already refuses to choose a disabled option and already skips
  // it in arrow/Home/End traversal, so a row that can state "unreachable, and
  // here is why" needs no new interaction contract.
  return <div class="preference-row"><span>{label}</span><MenuSelect className="preference-menu" ariaLabel={label} value={value} disabled={disabled} placement={placement} options={options.map(([id, name, description, optionDisabled]) => ({ value: id, label: name, ...(description ? { description } : {}), ...(optionDisabled ? { disabled: true } : {}) }))} leading={leading ? (option) => leading(option.value) : undefined} onChange={onChange} /></div>;
}
