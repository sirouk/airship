import { useEffect, useMemo, useRef } from "preact/hooks";
import { trapFocus } from "./focus-trap";
import { destinationLabel } from "./navigation-model";
import {
  NAVIGATION_JUMPS,
  PROFILE_CHORD_LIMIT,
  SHORTCUT_SHEET_CHORD,
  useOpenerRestore,
} from "./platform-shell";

/**
 * The keyboard layer's printed form, deferred out of first paint.
 *
 * It lives in its own module for the reason `app.tsx` defers the approval dock
 * and the resume report: the entry chunk's gzip ceiling does not move for
 * feature work, and a sheet nobody sees until they press `?` has no business
 * being fetched before the first frame. `app.tsx` imports it when the sheet is
 * first opened.
 */

export type ShortcutRow = Readonly<{ keys: readonly string[]; label: string; note?: string }>;
export type ShortcutGroup = Readonly<{ title: string; note?: string; rows: readonly ShortcutRow[] }>;

/**
 * Every chord the shell binds, derived rather than listed.
 *
 * The destination rows are read straight out of `NAVIGATION_JUMPS` and named
 * through `destinationLabel`, so a chord that is rebound — or a destination
 * that is renamed — moves the sheet with it. A legend maintained by hand is how
 * a shortcut sheet ends up teaching a key that changed two releases ago.
 *
 * The typing-focus note is not decoration. Airship claims the composer on every
 * cold chat load (app.tsx documents it), and `useGlobalNavigationJumps`
 * correctly refuses to steal keys from a text field — so measured from where a
 * person actually lands, `g x` and every other chord did nothing at all and
 * nothing on screen said why. Escape in an empty composer is the way out, and
 * this is where that is stated.
 */
export function keyboardShortcutGroups(
  profiles: readonly Readonly<{ name: string }>[] = [],
): readonly ShortcutGroup[] {
  const groups: ShortcutGroup[] = [
    Object.freeze({
      title: "Anywhere",
      rows: Object.freeze([
        Object.freeze({ keys: Object.freeze(["⌘K"]), label: "Command palette", note: "Ctrl+K on Windows and Linux" }),
        Object.freeze({ keys: Object.freeze([SHORTCUT_SHEET_CHORD]), label: "This sheet" }),
        Object.freeze({ keys: Object.freeze(["⌘\\"]), label: "Collapse or expand the navigation rail" }),
        Object.freeze({ keys: Object.freeze(["Esc"]), label: "Close an overlay and return the keyboard to the control that opened it" }),
      ]),
    }),
    Object.freeze({
      title: "Go to a destination",
      note: "Type g, then the second key within a second.",
      rows: Object.freeze(Object.entries(NAVIGATION_JUMPS).map(([key, view]) => Object.freeze({
        keys: Object.freeze(["g", key]),
        label: destinationLabel(view),
      }))),
    }),
  ];
  if (profiles.length) groups.push(Object.freeze({
    title: "Switch profile",
    note: "Each profile keeps its own conversations, draft, workspace and terminal.",
    rows: Object.freeze(profiles.slice(0, PROFILE_CHORD_LIMIT).map((profile, index) => Object.freeze({
      keys: Object.freeze(["g", String(index + 1)]),
      label: profile.name,
    }))),
  }));
  groups.push(Object.freeze({
    title: "In the message box",
    note: "Chords are inert while a text field has focus — Airship never steals a key you are typing.",
    rows: Object.freeze([
      Object.freeze({ keys: Object.freeze(["↵"]), label: "Send, or queue while a turn is running" }),
      Object.freeze({ keys: Object.freeze(["⇧", "↵"]), label: "New line" }),
      Object.freeze({ keys: Object.freeze(["/"]), label: "Slash commands, with ↑ ↓ to choose and Tab to accept" }),
      Object.freeze({ keys: Object.freeze(["Esc"]), label: "Leave an empty message box", note: "Focus moves to the conversation, where the chords above work. With a draft in it, Esc closes the command list; Shift+Tab still steps out." }),
    ]),
  }));
  return Object.freeze(groups);
}

/**
 * The sheet itself.
 *
 * A dialog rather than a Preferences section: it is opened by a key from
 * anywhere, including from inside another surface that owns the keyboard, and
 * it has to be dismissable without deciding anything. It restores focus to its
 * opener through the same contract the palette uses.
 */
export function KeyboardShortcutsSheet({ open, profiles, onClose }: Readonly<{
  open: boolean;
  profiles?: readonly Readonly<{ name: string }>[];
  onClose(): void;
}>) {
  const dialog = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => keyboardShortcutGroups(profiles ?? []), [profiles]);
  useOpenerRestore(open);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;
  return (
    <div class="platform-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialog}
        class="shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          else if (event.key === "Tab") trapFocus(event, dialog.current);
        }}
      >
        <header>
          <div>
            <span class="eyebrow">Keyboard</span>
            <h2 id="shortcut-sheet-title">Shortcuts</h2>
          </div>
          <button type="button" onClick={onClose}>Done</button>
        </header>
        {groups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            {group.note ? <p>{group.note}</p> : null}
            <dl>
              {group.rows.map((row) => (
                <div key={`${group.title}:${row.label}`}>
                  <dt>{row.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
                  <dd>{row.label}{row.note ? <small>{row.note}</small> : null}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

