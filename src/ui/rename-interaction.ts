/**
 * One rename gesture, stated once.
 *
 * Rename shipped as four different interactions in four places. In Chat you
 * start it with a click or F2, Enter commits, Escape cancels and clicking away
 * commits (src/ui/chat/session-bar.tsx). On a terminal tab you can only start
 * it by double-clicking, and clicking away also commits. On a row in All
 * conversations there is no keyboard start at all, and clicking away leaves the
 * form open and saves nothing — so the identical gesture commits a half-typed
 * name on two routes and discards it on a third, which is a difference a person
 * only discovers by losing a title. In the Workspace tree it is a dialog.
 *
 * The verb is one verb, so its keys are one module. Every editor that renames a
 * user-named thing takes its key handling from here rather than restating it:
 * a reference cannot drift, four copies already have.
 */

/** The key that starts a rename from a focused, not-yet-editing control. */
export const RENAME_SHORTCUT_KEY = "F2";

/**
 * Named in the control's own tooltip because F2 is not a key anyone guesses,
 * and a shortcut nothing prints is a shortcut only its author has.
 */
export const RENAME_START_HINT = "Double-click or F2 to rename";

export type RenameEditorActions = Readonly<{
  /** Enter, and clicking away: the half-typed name is kept, never dropped. */
  commit(): void;
  /** Escape: the original name stands. */
  cancel(): void;
}>;

/** Click-or-F2 to start, on the control that shows the name at rest. */
export function renameStartKeyHandler(start: () => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.defaultPrevented || event.key !== RENAME_SHORTCUT_KEY) return;
    event.preventDefault();
    start();
  };
}

/**
 * Enter commits, Escape cancels — inside the live editor.
 *
 * `isComposing` is the reason this is not two lines at each call site: an IME
 * candidate is accepted with Enter, so committing on that keystroke renames the
 * thing to a half-composed word.
 */
export function renameEditorKeyHandler(actions: RenameEditorActions): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      actions.commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      actions.cancel();
    }
  };
}
