import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RENAME_SHORTCUT_KEY,
  RENAME_START_HINT,
  renameEditorKeyHandler,
  renameStartKeyHandler,
} from "./rename-interaction";

/** A keydown with only the fields these handlers read; `node` has no KeyboardEvent. */
function keydown(key: string, options: Readonly<{ composing?: boolean; alreadyHandled?: boolean }> = {}) {
  let prevented = options.alreadyHandled ?? false;
  const event = {
    key,
    isComposing: options.composing ?? false,
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented };
}

describe("the one rename gesture", () => {
  it("starts on the shortcut key and on nothing else", () => {
    const started: string[] = [];
    const handler = renameStartKeyHandler(() => started.push("start"));

    const shortcut = keydown(RENAME_SHORTCUT_KEY);
    handler(shortcut.event);
    expect(started).toEqual(["start"]);
    // The browser's own F2 handling must not also run.
    expect(shortcut.prevented()).toBe(true);

    for (const key of ["Enter", "F1", "r", "Escape"]) handler(keydown(key).event);
    expect(started).toEqual(["start"]);

    // A key another handler has already claimed is not a second rename start.
    handler(keydown(RENAME_SHORTCUT_KEY, { alreadyHandled: true }).event);
    expect(started).toEqual(["start"]);
  });

  it("commits on Enter, cancels on Escape, and never renames a half-composed word", () => {
    const acts: string[] = [];
    const handler = renameEditorKeyHandler({
      commit: () => acts.push("commit"),
      cancel: () => acts.push("cancel"),
    });

    const enter = keydown("Enter");
    handler(enter.event);
    // Prevented, or a rename inside a form also submits it.
    expect(enter.prevented()).toBe(true);

    // An IME accepts a candidate with Enter. Committing there renames the
    // conversation to whatever the composition happened to hold.
    handler(keydown("Enter", { composing: true }).event);

    const escape = keydown("Escape");
    handler(escape.event);
    expect(escape.prevented()).toBe(true);

    handler(keydown("a").event);
    expect(acts).toEqual(["commit", "cancel"]);
  });
});

describe("Chat takes its rename keys from the shared contract", () => {
  const bar = readFileSync(new URL("./chat/session-bar.tsx", import.meta.url), "utf8");

  it("imports the handlers instead of restating the keys", () => {
    /*
     * The same four lines were written out at each editor, which is how the
     * product ended up with four rename contracts: F2 in Chat and nowhere else,
     * and blur committing on two routes while discarding the edit on a third.
     * A reference cannot drift; four copies already had.
     */
    expect(bar).toContain('from "../rename-interaction"');
    expect(bar).toContain("onKeyDown={renameStartKeyHandler(startRename)}");
    expect(bar).toContain("onKeyDown={renameEditorKeyHandler({ commit: () => void commitRename(), cancel: cancelRename })}");
    expect(bar).not.toContain('event.key === "F2"');
    expect(bar).not.toContain("event.isComposing");
  });

  it("prints the shortcut on the control it works on", () => {
    // A tooltip that named only the mouse gesture left F2 discoverable by
    // nothing at all — and it is the only keyboard start this control has.
    expect(RENAME_START_HINT).toContain(RENAME_SHORTCUT_KEY);
    expect(bar).toContain("title={`${title} · ${RENAME_START_HINT}`}");
  });
});
