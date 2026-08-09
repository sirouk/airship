import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * One shape for "are you sure", across every surface that cannot be undone.
 *
 * Airship shipped three grammars for the same question: a designed modal for
 * deleting one workspace file, the browser's grey `window.confirm` for removing
 * a profile and (formerly) for resetting preferences, and — for closing a
 * terminal tab, which ends a live process and its shell history — no gate at
 * all. A native
 * confirm cannot carry the consequence sentence the modal carries, cannot be
 * styled, and on iOS is stamped with the origin, so it reads as the browser
 * asking rather than as Airship asking.
 *
 * `src/ui/confirm-dialog.tsx` is the one implementation. The holdouts below are
 * pinned exactly rather than merely allowed: a new `window.confirm` anywhere in
 * `src/ui` fails this test, and so does *fixing* one of them without deleting
 * its line here — which is the only way a debt list stays honest.
 */
const NATIVE_CONFIRM_HOLDOUTS = Object.freeze([
  "app.tsx",
]);

async function* uiSources(directory: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) yield* uiSources(child);
    else if (/\.tsx?$/u.test(entry.name) && !entry.name.includes(".test.")) yield child;
  }
}

describe("destructive confirmation", () => {
  it("uses no native browser confirm outside the file still owed a pass", async () => {
    const offenders: string[] = [];
    for await (const file of uiSources(new URL("./", import.meta.url))) {
      const source = await readFile(file, "utf8");
      if (/\bwindow\.confirm\(/u.test(source)) offenders.push(file.pathname.split("/").at(-1) ?? "");
    }
    expect(offenders.sort()).toEqual([...NATIVE_CONFIRM_HOLDOUTS].sort());
  });

  it("keeps the Escape key, the Tab trap and the danger colour in one place", async () => {
    const primitive = await readFile(new URL("./confirm-dialog.tsx", import.meta.url), "utf8");
    expect(primitive).toContain('if (event.key === "Escape")');
    expect(primitive).toContain("trapFocus(event, box.current)");
    expect(primitive).toContain('destructive ? "danger" : "primary"');
  });

  /*
   * A gate that takes the keyboard has to give it back. Measured on Preferences:
   * `Reset preferences` opens this dialog, Cancel unmounts it, and with no
   * restoration focus fell to `<body>` — outside the element that carries the
   * *parent* dialog's `Tab`/`trapFocus` handler, so the next Tab was the
   * browser's and walked into the shell behind the scrim. That is an escaped
   * trap, not merely a lost one, and it is invisible to a pointer user.
   *
   * `useOpenerRestore` is asserted absent on purpose: it skips openers inside
   * OVERLAY_ROOTS, and every opener of this primitive is a control inside the
   * surface still open behind it, so it would send focus out of that surface.
   */
  it("hands the keyboard back to whoever asked the question", async () => {
    const primitive = await readFile(new URL("./confirm-dialog.tsx", import.meta.url), "utf8");
    expect(primitive).toContain("const active = document.activeElement;");
    expect(primitive).toContain("target?.isConnected) target.focus({ preventScroll: true })");
    expect(primitive).not.toContain("useOpenerRestore(");
  });

  it("has every gated surface import that one primitive rather than rebuild it", async () => {
    for (const file of ["workspace-view.tsx", "sources-view.tsx", "terminal-view.tsx"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).toContain('import { ConfirmDialog } from "./confirm-dialog";');
      // No surface may keep a second copy of the modal shell.
      expect(source, file).not.toContain('class="workbench-dialog-scrim"');
    }
  });

  /*
   * Asking is half of it; the other half is what the page says afterwards.
   *
   * Removing an authored skill left a class-less `<p>` inheriting the route's
   * body ink — 17px at `--ink`, the same type as ordinary prose, transparent
   * ground, no border, no padding — floating in the gutter between the card
   * grid and the boundary callout. Measured at desktop-1440 it was a 1156px
   * line reading "Audit probe removed." with nothing around it, which is how a
   * page renders text it has no opinion about. It was the only in-page record
   * that a skill had been destroyed, and the least emphasised thing on screen.
   * A styled topbar toast fires in parallel and is what catches the eye; this
   * is what remains once that has gone.
   */
  it("leaves a found-able record behind, not unstyled prose in a gutter", async () => {
    const view = await readFile(new URL("./skills-manager-view.tsx", import.meta.url), "utf8");
    expect(view).toContain('<p class="skills-action-status" role="status" aria-live="polite">');
    // The class-less spelling is the defect; a status paragraph with no class
    // is a status paragraph with no box.
    expect(view).not.toContain('<p role="status" aria-live="polite">{status}</p>');

    const routes = await readFile(new URL("./routes.css", import.meta.url), "utf8");
    const chip = /\n\.skills-action-status \{([^}]+)\}/u.exec(routes)?.[1] ?? "";
    expect(chip).toContain("border: 1px solid var(--line)");
    expect(chip).toContain("border-radius: var(--radius-control)");
    expect(chip).toContain("background: var(--surface-soft)");
    /*
     * Neutral, and the width of its own sentence. The destruction already
     * happened and succeeded, so painting it in danger ink is how danger ink
     * stops being read; and a chip stretched across a 1160px measure is a
     * banner, which is what the toast already was.
     */
    expect(chip).toContain("justify-self: start");
    expect(chip).not.toContain("var(--danger)");
    expect(chip).not.toContain("var(--v-failed)");
  });
});
