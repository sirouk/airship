import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CUSTOM_SKILL_ID_PREFIX } from "../profiles/domain";
import { proposedSkillId } from "./skill-editor";

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
