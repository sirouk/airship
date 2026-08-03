import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * One shape for "are you sure", across every surface that cannot be undone.
 *
 * Airship shipped three grammars for the same question: a designed modal for
 * deleting one workspace file, the browser's grey `window.confirm` for removing
 * a profile and for resetting preferences, and — for closing a terminal tab,
 * which ends a live process and its shell history — no gate at all. A native
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
  // The palette and the preferences dialog moved to `platform-overlays.tsx`
  // when they left the entry chunk; the reset confirmation went with them.
  "platform-overlays.tsx",
]);

async function* uiSources(directory: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) yield* uiSources(child);
    else if (/\.tsx?$/u.test(entry.name) && !entry.name.includes(".test.")) yield child;
  }
}

describe("destructive confirmation", () => {
  it("uses no native browser confirm outside the two files still owed a pass", async () => {
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

  it("has every gated surface import that one primitive rather than rebuild it", async () => {
    for (const file of ["workspace-view.tsx", "sources-view.tsx", "terminal-view.tsx"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).toContain('import { ConfirmDialog } from "./confirm-dialog";');
      // No surface may keep a second copy of the modal shell.
      expect(source, file).not.toContain('class="workbench-dialog-scrim"');
    }
  });
});
