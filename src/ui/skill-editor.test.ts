import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CUSTOM_SKILL_ID_PREFIX } from "../profiles/domain";
import { proposedSkillId } from "./skill-editor";
import { editorPanelAlignment, slicedBarClearance } from "./skills-manager-view";

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
   * And it has to be an alignment only when there is something to align, and
   * only as far as it has to go. Firing it for New skill on a viewport where the
   * panel was in frame all along scrolled the route's own mode tabs and APPLIES
   * TO scope selector off the top of a page nobody had asked to move; asking
   * only whether the panel's top edge was in frame then left `Create skill` and
   * `Cancel` under the fold at every device class but 1920x1080.
   */
  it("aligns the mounted panel and hands it the keyboard", () => {
    const source = skillsSource();
    expect(source).toContain("if (!editorTarget || !SkillEditorPanel) return;");
    // The alignment the helper chose, not one this call site picks for itself.
    // A literal `"start"` is the shape that threw the route's tabs and scope
    // selector away on every panel that only needed a hundred pixels.
    expect(source).toContain("panel.scrollIntoView({ block: alignment });");
    expect(source).not.toContain('scrollIntoView({ block: "start" })');
    // And the frame that lands on gets settled, inside the same branch: the
    // clearance is only owed where this route moved the page itself.
    expect(source).toContain("      panel.scrollIntoView({ block: alignment });\n      clearSlicedBar(panel, scroller);");
    // The keyboard lands in the form whether or not the page had to move; only
    // the scroll is conditional, and `preventScroll` keeps focus from re-choosing
    // a position the branch above already decided.
    expect(source).toContain('panel.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });');
    expect(source).toContain("}, [editorTarget, SkillEditorPanel]);");
    // The element the alignment reads. `SkillEditor` is a plain function
    // component, so a ref handed to it would not reach the panel's own node.
    expect(source).toContain("<div ref={editorRef}>");
  });

  /*
   * The cases the three regressions between them describe. `scrollport` is the
   * box the reader actually sees the panel through — the shell's scrolling
   * `.main`, not the window, because the route chrome that got carried away
   * lives inside it. 57..900 is the desktop-1440 class, measured.
   */
  const scrollport = { top: 57, bottom: 900 } as const;

  it("carries the panel to the reader when Edit was pressed from a card below it", () => {
    // The panel is above the fold entirely: this is the dead-button case.
    expect(editorPanelAlignment({ top: -400, bottom: -120 }, scrollport)).toBe("start");
    // And the case where it is below: a short catalog on a tall screen. It fits,
    // so the least scroll that shows all of it is the one that gets used.
    expect(editorPanelAlignment({ top: 1200, bottom: 1900 }, scrollport)).toBe("end");
  });

  it("leaves the page alone only when the whole panel is in frame", () => {
    // wide-1920 pressing New skill, measured: the panel opened at y=428 and
    // ended at y=1006 inside a scrollport ending at 1080, actions included.
    // Nothing needed moving, and moving it cost the author the scope the skill
    // resolves for.
    expect(editorPanelAlignment({ top: 428, bottom: 1006 }, { top: 58, bottom: 1080 })).toBe(undefined);
  });

  /*
   * The regression this rule was rewritten for, measured off the 1440x900
   * capture: the panel opened at y=428 and ran 577px to y=1005, so its NAME
   * field sat at 513..546 — head in frame, and the gate that asked only about
   * the head left the page alone — while `Create skill` and `Cancel` sat at
   * 972..998, under a fold at 899. A form whose submit cannot be reached is
   * worse than one that opens off-screen, because the reader believes they are
   * already in it.
   */
  it("brings the actions in when the panel's head is in frame and its foot is not", () => {
    expect(editorPanelAlignment({ top: 428, bottom: 1005 }, scrollport)).toBe("end");
  });

  it("shows a panel taller than the scrollport from its beginning", () => {
    // phone-320: the panel opened at y=347 and its single-column form was still
    // unfinished at the clip 164px later, inside a scrollport only 454px tall,
    // so no scroll position holds all of it. The choice is which end to lose,
    // and `end` would lose the header, the first field and the keyboard with it.
    expect(editorPanelAlignment({ top: 347, bottom: 1128 }, { top: 57, bottom: 511 })).toBe("start");
    // Same shape one class up, editing a skill with a long instruction: a header
    // on the last pixels of the fold reads as nothing having happened.
    expect(editorPanelAlignment({ top: 880, bottom: 2000 }, scrollport)).toBe("start");
  });

  it("asks nothing of the placeholder the deferred chunk stands behind", () => {
    // The one-line "Loading the skill editor…" line has no foot below the fold
    // to rescue, and a visible placeholder is already the feedback.
    expect(editorPanelAlignment({ top: 447, bottom: 470 }, scrollport)).toBe(undefined);
  });
});

/*
 * The frame `end` settles on is a subtraction, and a subtraction does not care
 * what it stops in the middle of. Measured on the shipped build it stopped
 * inside the route's own chrome twice: the mode tab strip at tablet-768, cut so
 * that Profiles / Skills / Capabilities showed as three pills with their tops
 * sliced off in every editor state, and the APPLIES TO scope select at
 * desktop-1440, cut through the x-height of `General` — the name of the profile
 * the skill being authored resolves for. Nobody scrolled there; this route did.
 */
describe("the frame this route chooses is one a person can read", () => {
  const desktop = { top: 57, bottom: 900 } as const;
  const tablet = { top: 58, bottom: 1024 } as const;

  it("clears a scope row the alignment cut through its labels", () => {
    // desktop-1440 pressing New skill: the 36px scope row settled at 40..73,
    // 16px of it showing under a frame that starts at 57, with the panel's head
    // 261px below that edge. 16px of a 261px allowance buys the whole bar.
    expect(slicedBarClearance([{ top: 40, bottom: 73 }], desktop, 261)).toBe(16);
  });

  it("clears a tab strip whose pills were sliced in every editor state", () => {
    // tablet-768: the 56px strip settled at 46..102 under a frame starting at
    // 58, so 44px showed and the pill tops were gone. Cleared it costs 44 of a
    // 337px allowance, and the APPLIES TO row below it arrives whole.
    expect(slicedBarClearance([{ top: 46, bottom: 102 }], tablet, 337)).toBe(44);
  });

  it("leaves a body alone however it was cut", () => {
    /*
     * The regression this rule would be if it had no height limit. At
     * laptop-1024 the frame stops 12px into the 125px scope/effective-set
     * toolbar; clearing it costs 113px and takes Profile scope, Effective set
     * and New conversation with this set off the page — nine tenths of a panel
     * that was in frame, spent to tidy the tenth that was not.
     */
    expect(slicedBarClearance([{ top: 45, bottom: 170 }], { top: 57, bottom: 768 }, 122)).toBe(0);
  });

  it("never buys a bar with the panel's own head", () => {
    // The same tablet strip against a `start` alignment, which leaves no gap
    // between the panel's head and the frame's top. Every viewport whose
    // scrollport is shorter than the panel is this case — phone-320, phone-390,
    // phone-430 and landscape-932 — and none of them moves.
    expect(slicedBarClearance([{ top: 46, bottom: 102 }], tablet, 0)).toBe(0);
    // Nor with most of it: an allowance that cannot cover the bar is not spent
    // part-way, which would leave the bar sliced and the panel lower as well.
    expect(slicedBarClearance([{ top: 46, bottom: 102 }], tablet, 43)).toBe(0);
  });

  it("stays still when the frame stops between blocks", () => {
    // A bar wholly above the edge is already gone, and one wholly below it is
    // whole. Sub-pixel layout is neither.
    expect(slicedBarClearance([{ top: 4, bottom: 40 }, { top: 70, bottom: 106 }], desktop, 400)).toBe(0);
    expect(slicedBarClearance([{ top: 21, bottom: 57.4 }], desktop, 400)).toBe(0);
  });

  it("clears the lowest foot it cut, not the first one it found", () => {
    /*
     * Blocks that merely stack can only ever have one of them across a given
     * edge, so this is about the ones that do not: a negative margin, an
     * overlapping absolutely-positioned sibling, two nesting levels reported at
     * once. Clearing to the higher foot would stop inside the lower block, so
     * the frame has to pass both, and the order they arrive in is the DOM's.
     */
    expect(slicedBarClearance([{ top: 30, bottom: 90 }, { top: 40, bottom: 96 }], { top: 59, bottom: 1024 }, 200))
      .toBe(37);
  });

  it("reads the blocks off the panel's own ancestry rather than a selector list", () => {
    /*
     * The tab strip and the scope row are written by `app.tsx`, above this view
     * entirely; the route header and the toolbar are written by this one. A
     * selector list here would be a fourth copy of that arrangement and would
     * go quietly wrong the first time any of the four moved.
     */
    const source = skillsSource();
    expect(source).toContain("for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling)");
    expect(source).toContain("node && node !== scroller");
    expect(source).not.toMatch(/querySelector(All)?\(["'`][^"'`]*profile-hub/u);
  });
});

describe("a save that was refused says so where the person is looking", () => {
  /*
   * The sentence renders under the actions, and the actions are the last thing
   * in the panel: at desktop-1440 `Create skill` sat at 887 in a 900px viewport
   * and at tablet-768 at 1002 in a 1024px one, so the only account of why the
   * save did not commit was below the fold at both, and the button read as
   * dead. Nothing else moves the page — the route keeps the panel open on a
   * refusal, deliberately, so the draft survives.
   */
  it("brings the refusal into the frame with the least scroll that does it", () => {
    const source = editorSource();
    expect(source).toContain('statusRef.current?.scrollIntoView({ block: "nearest" });');
    expect(source).toContain("}, [status]);");
    // `nearest`, so a refusal already in frame moves nothing and the field the
    // person has to go back and fix stays where they left it.
    expect(source).not.toContain('scrollIntoView({ block: "center" })');
    expect(source).not.toContain('scrollIntoView({ block: "start" })');
  });

  it("announces it and hangs it off the button that produced it", () => {
    const source = editorSource();
    // Everything this element can hold is a refusal — the success path closes
    // the panel first — so a polite region is the wrong instrument.
    expect(source).toContain('id={SAVE_STATUS_ID} class="skill-editor-status" role="alert"');
    expect(source).not.toContain('class="skill-editor-status" role="status"');
    expect(source).toContain("aria-describedby={status ? SAVE_STATUS_ID : undefined}");
  });

  it("gives the scrolled-to sentence the panel's foot instead of the window's edge", () => {
    const sheet = readFileSync(new URL("./skill-editor.css", import.meta.url), "utf8");
    const status = /\n\.skill-editor-status \{([\s\S]*?)\n\}/u.exec(sheet)?.[1] ?? "";
    // `nearest` stops as soon as the margin box is inside the scrollport, which
    // bare would leave the panel's padding, border and the gap to the grid
    // below the fold — the one sentence that matters arriving flush against the
    // bottom edge, looking like the top of something else.
    expect(status).toContain("scroll-margin-block-end: calc(var(--sp-3) + 14px);");
    // The two lengths are the panel's own, so the pairing is checkable here.
    expect(/\n\.skill-editor \{([\s\S]*?)\n\}/u.exec(sheet)?.[1] ?? "").toContain("margin-bottom: 14px;");
    expect(/\n\.skill-editor \{([\s\S]*?)\n\}/u.exec(sheet)?.[1] ?? "").toContain("padding: var(--sp-3);");
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
