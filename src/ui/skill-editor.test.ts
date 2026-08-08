import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CUSTOM_SKILL_ID_PREFIX } from "../profiles/domain";
import { proposedSkillId } from "./skill-editor";
import { editorPanelNeedsAlignment } from "./skills-manager-view";

function editorSource(): string {
  return readFileSync(new URL("./skill-editor.tsx", import.meta.url), "utf8");
}

function appSource(): string {
  return readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
}

function skillsSource(): string {
  return readFileSync(new URL("./skills-manager-view.tsx", import.meta.url), "utf8");
}

describe("the id a new skill is proposed under", () => {
  it("always lands inside the authored namespace", () => {
    for (const name of ["House style", "  ", "Ünïcödé!!", "-".repeat(200)]) {
      expect(proposedSkillId(name).startsWith(CUSTOM_SKILL_ID_PREFIX)).toBe(true);
    }
  });

  it("produces an identifier `createSkillRevision` accepts", () => {
    // Same shape as `identifier()` in `domain.ts`: lowercase, path-free, no
    // leading or trailing separator, at most 128 characters.
    const pattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
    expect(proposedSkillId("House Style")).toBe("custom.house-style");
    expect(pattern.test(proposedSkillId("House Style"))).toBe(true);
    expect(pattern.test(proposedSkillId("   ---   "))).toBe(true);
    expect(pattern.test(proposedSkillId("A".repeat(300)))).toBe(true);
    // A name that slugs to nothing still yields a legal id rather than a bare
    // prefix ending in the separator, which `identifier()` refuses.
    expect(proposedSkillId("!!!")).toBe("custom.skill");
  });
});

describe("the panel cannot report a save it did not make", () => {
  /*
   * `onSave` closes the panel, so a `setStatus("Saved")` after it renders into
   * an unmounted tree — a sentence written to a surface nobody can read. The
   * commit's own status line, set by `saveSkillRevision` in `app.tsx`, is what
   * reaches the person, and it names the storage authority.
   */
  it("sets no status between the save and the close", () => {
    const save = /async function save\(\)[\s\S]*?\n  \}/u.exec(editorSource())?.[0] ?? "";
    expect(save).toContain("await onSave(");
    expect(save).toContain("onClose();");
    // The success path only: everything between the commit and the close. A
    // `setStatus` in the catch below is the panel doing its job.
    const settled = save.slice(save.indexOf("await onSave("), save.indexOf("} catch ("));
    expect(settled).toContain("onClose();");
    expect(settled).not.toContain("setStatus(");
  });

  it("shows the refusal a rejected save carries, verbatim", () => {
    const source = editorSource();
    expect(source).toContain("setStatus(error instanceof Error ? error.message : String(error));");
  });
});

describe("a skill's ID is fixed once it exists", () => {
  it("disables the ID field outside creation", () => {
    expect(editorSource()).toContain("disabled={!creating}");
  });

  /*
   * `useState(() => initialFields(target))` runs its initializer on mount only.
   * Without a key derived from the target, pressing Edit on `custom.b` while
   * `custom.a` was open kept A's fields under B's heading, and Save then failed
   * with "A skill's ID is fixed when it is created." about a skill nobody had
   * opened. The mount-only initializer is the mechanism, so both halves are
   * asserted: the panel keeps it, and the caller keys the element.
   */
  it("is remounted per target by the caller's key", () => {
    expect(editorSource()).toContain("useState<Fields>(() => initialFields(target))");
    expect(skillsSource()).toContain(
      'key={`${editorTarget.mode}:${editorTarget.mode === "new" ? "" : editorTarget.source.skillId}`}',
    );
  });
});

describe("the authoring panel stays off the first-paint path", () => {
  it("is fetched through the recovery loader, not a bare dynamic import", () => {
    // A module URL that has failed once is recorded as failed in the document's
    // module map, so a plain retry issues no request at all.
    expect(skillsSource()).toContain('"skill-editor",\n      () => import("./skill-editor"),');
    expect(skillsSource()).not.toMatch(/import\s+\{[^}]*SkillEditor[^}]*\}\s+from\s+"\.\/skill-editor"/u);
  });

  it("carries its own stylesheet rather than adding to the route sheet", () => {
    expect(editorSource()).toContain('import "./skill-editor.css";');
  });
});

describe("pressing Edit produces a response the person can see", () => {
  /*
   * The panel renders above the grid, so on a catalog long enough to scroll —
   * which is every catalog with an authored skill in it — clicking Edit changed
   * nothing inside the viewport and the primary authoring verb read as a dead
   * button. The panel is a deferred chunk, so the alignment has to wait for the
   * component rather than fire on the "Loading…" line that stands in for it.
   *
   * And it has to be an alignment only when there is something to align: firing
   * it for New skill on a desktop viewport, where the panel was in frame all
   * along, scrolled the route's own mode tabs and APPLIES TO scope selector off
   * the top of a page nobody had asked to move.
   */
  it("aligns the mounted panel and hands it the keyboard", () => {
    const source = skillsSource();
    expect(source).toContain("if (!editorTarget || !SkillEditorPanel) return;");
    expect(source).toContain("if (needed) panel.scrollIntoView({ block: \"start\" });");
    // The keyboard lands in the form whether or not the page had to move; only
    // the scroll is conditional, and `preventScroll` keeps focus from re-choosing
    // a position the branch above already decided.
    expect(source).toContain('const field = panel.querySelector<HTMLInputElement>("input");');
    expect(source).toContain("field?.focus({ preventScroll: true });");
    expect(source).toContain("}, [editorTarget, SkillEditorPanel]);");
    // The element the alignment reads. `SkillEditor` is a plain function
    // component, so a ref handed to it would not reach the panel's own node.
    expect(source).toContain("<div ref={editorRef}>");
  });

  /*
   * The four cases the two regressions between them describe. `scrollport`
   * is the box the reader actually sees the panel through — the shell's
   * scrolling `.main`, not the window, because the route chrome that got
   * carried away lives inside it.
   */
  const scrollport = { top: 57, bottom: 900 } as const;

  it("carries the panel to the reader when Edit was pressed from a card below it", () => {
    // The panel is above the fold entirely: this is the dead-button case.
    expect(editorPanelNeedsAlignment({ top: -400, bottom: -120 }, { top: -350, bottom: -320 }, scrollport)).toBe(true);
    // And the case where it is below: a short catalog on a tall screen.
    expect(editorPanelNeedsAlignment({ top: 1200, bottom: 1900 }, { top: 1260, bottom: 1290 }, scrollport)).toBe(true);
  });

  it("leaves the page alone when the panel and its first field are already in frame", () => {
    // desktop-1440 pressing New skill: the panel header sat at y=447 with the
    // mode tabs, APPLIES TO and the scope card above it. Nothing needed moving,
    // and moving it cost the author the scope the skill resolves for.
    expect(editorPanelNeedsAlignment({ top: 447, bottom: 1600 }, { top: 515, bottom: 545 }, scrollport)).toBe(false);
  });

  it("still aligns when only the panel's header made it onto the fold", () => {
    // A header on the last few pixels of the scrollport reads as nothing having
    // happened, which is the failure the alignment exists for.
    expect(editorPanelNeedsAlignment({ top: 880, bottom: 2000 }, { top: 948, bottom: 978 }, scrollport)).toBe(true);
  });

  it("asks nothing of a field that is not mounted yet", () => {
    // The deferred chunk's one-line "Loading the skill editor…" placeholder has
    // no input, and a visible placeholder is already the feedback.
    expect(editorPanelNeedsAlignment({ top: 447, bottom: 470 }, undefined, scrollport)).toBe(false);
  });
});

describe("the panel fits the narrowest phone whatever the skill is called", () => {
  const sheet = readFileSync(new URL("./skill-editor.css", import.meta.url), "utf8");

  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`\\n${escaped} \\{([^}]+)\\}`, "u").exec(sheet)?.[1] ?? "";
  }

  /*
   * The header's `<code>` is `white-space: nowrap`, so a long name makes the
   * proposed skill ID one unbreakable run. A grid item's automatic minimum size
   * is its min-content, so that run floored the panel's track and the whole
   * panel rendered wider than a 390px viewport: no right border, the Skill ID
   * placeholder off-screen, and the Name input's left edge scrolled out of
   * view. The `min-width: 0` the `<code>` already carried could never fire
   * until the header itself was allowed to shrink.
   */
  it("lets the header shrink so the skill ID ellipsises instead of widening the panel", () => {
    expect(rule(".skill-editor > header")).toContain("min-width: 0");
    expect(rule(".skill-editor > header code")).toContain("min-width: 0");
    expect(rule(".skill-editor > header code")).toContain("text-overflow: ellipsis");
  });

  it("gives the title wrapper the same allowance and the heading a break rule", () => {
    // A name typed as one long word offers the h2 no break opportunity, so the
    // wrapper needs both halves: permission to shrink, and somewhere to break.
    expect(rule(".skill-editor > header > div")).toContain("min-width: 0");
    expect(rule(".skill-editor > header h2")).toContain("overflow-wrap: anywhere");
  });
});

describe("an explicit inherit is never stored", () => {
  /*
   * The defect both refuters found: `skillModes: { ...profile.skillModes,
   * [skillId]: mode }` wrote `"inherit"` as a key, `skillReferences` counted it,
   * and Remove refused permanently naming a profile the skill does not reach.
   */
  it("routes the profile mode write through the deleting helper", () => {
    const source = appSource();
    expect(source).toContain("skillModes: profileSkillModes(profile.skillModes, skillId, mode),");
    expect(source).toContain('if (mode === "inherit") delete next[skillId];');
    expect(source).not.toContain("skillModes: { ...profile.skillModes, [skillId]: mode }");
  });
});
