import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Names ARIA throws away.
 *
 * `aria-label` / `aria-labelledby` on a bare `<div>`, `<span>` or `<p>` is
 * discarded: ARIA forbids naming an element whose computed role is `generic`
 * (or `paragraph`), so the string reads as an accessibility decision in the
 * source and reaches no one. Where the container's only other content is a
 * glyph, that leaves a control with no accessible text at all — the eligibility
 * matrix announced "✓" and "—", the runway bar announced nothing, and the Git
 * delta column announced two bare letters. Each of those was fixed by hand and
 * nothing stopped the next one, so the scan is the fix.
 *
 * The remedy is never to delete the label. Give the element the smallest role
 * that permits a name — `img` where the label is the only text, `group` for a
 * labelled cluster of content or controls, `region` for a landmark — or move
 * the words into the element they describe and drop the attribute.
 *
 * Scanned as source rather than rendered because the defect is in the markup a
 * component always emits; no render path can reach a name the browser deleted.
 */
const NAMEABLE_BY_ROLE_ONLY = /<(?:div|span|p)(?=[\s/>])/gu;
const CARRIES_A_NAME = /(?:^|\s)aria-label(?:ledby)?\s*=/u;
const CARRIES_A_ROLE = /(?:^|\s)role\s*=/u;
/**
 * The three roles that do not rescue a name. `presentation`/`none` remove the
 * element from the tree outright and `generic` is the computed role the whole
 * prohibition is about, so spelling one of them next to an `aria-label` is the
 * same defect wearing a role attribute — and skipping every element that
 * carries any `role=` was a hole in the scan, not a rule. A computed
 * `role={expression}` is taken at its word: this is a source scan and it cannot
 * evaluate one, but an author writing a dynamic role is choosing a real role.
 */
const ROLE_THAT_STILL_FORBIDS_A_NAME = /(?:^|\s)role\s*=\s*(["'])(?:presentation|none|generic)\1/u;

/**
 * `src/ui/app.tsx` is being edited concurrently in this same audit pass, so its
 * four containers are recorded here instead of touched. None of them is a lost
 * fact — each wraps text that is announced on its own — and each is one
 * `role="group"` away from clean.
 *
 * The count is load-bearing in both directions. An entry excuses exactly that
 * many occurrences, so a *second* container that happens to carry the same
 * label string is not admitted by the first one's pardon; and an entry that
 * excuses nothing fails the test, so fixing a container without deleting its
 * line here is caught rather than leaving a pardon behind for the next
 * offender to inherit. Delete the entry in the same commit as the `role`.
 */
const AWAITING_A_CONCURRENT_EDIT: ReadonlyMap<string, number> = new Map();

/**
 * The opening tag's attributes, brace- and quote-aware: an arrow function in an
 * `onClick` and a `>` inside a quoted value are both ordinary characters here,
 * and only a `>` at brace depth zero ends the tag.
 */
function attributesOfTag(source: string, start: number): string {
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(start, index);
  }
  return source.slice(start);
}

/** The name attribute verbatim, so the record below reads as what it excuses. */
function nameAttribute(attributes: string): string {
  const quoted = /aria-label(?:ledby)?\s*=\s*(["'])(?<value>[^"']*)\1/u.exec(attributes);
  if (quoted?.groups) return `aria-label="${quoted.groups.value}"`;
  const dynamic = /aria-label(?:ledby)?\s*=\s*\{(?<value>[^\n}]*)/u.exec(attributes);
  return `aria-label={${dynamic?.groups?.value.trim() ?? ""}…}`;
}

async function* componentFiles(directory: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) yield* componentFiles(child);
    else if (entry.name.endsWith(".tsx")) yield child;
  }
}

/** A name on this tag reaches nobody: no role at all, or a role that forbids one. */
function dropsItsName(attributes: string): boolean {
  if (!CARRIES_A_NAME.test(attributes)) return false;
  return !CARRIES_A_ROLE.test(attributes) || ROLE_THAT_STILL_FORBIDS_A_NAME.test(attributes);
}

describe("every ARIA name lands on an element allowed to have one", () => {
  it("finds no div, span or p named without a role", async () => {
    const root = new URL("../../", import.meta.url);
    const offenders: string[] = [];
    const unspent = new Map(AWAITING_A_CONCURRENT_EDIT);
    for await (const file of componentFiles(new URL("src/", root))) {
      const relative = file.pathname.slice(root.pathname.length);
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(NAMEABLE_BY_ROLE_ONLY)) {
        const start = match.index + match[0].length;
        const attributes = attributesOfTag(source, start);
        if (!dropsItsName(attributes)) continue;
        const record = `${relative} :: ${nameAttribute(attributes)}`;
        const excused = unspent.get(record) ?? 0;
        if (excused > 0) {
          unspent.set(record, excused - 1);
          continue;
        }
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${relative}:${line}: ${record}`);
      }
    }
    expect(offenders).toEqual([]);
    const rotted = [...unspent].flatMap(([record, left]) => (left > 0 ? [record] : []));
    expect(rotted, "fixed containers still pardoned — delete these from AWAITING_A_CONCURRENT_EDIT").toEqual([]);
  });

  it("sees a name on a bare container that a role would hide from it", () => {
    // The scanner is the whole guarantee, so it is exercised on markup shaped
    // like the defect it exists to catch — including the two shapes that broke
    // naive regex attempts: a `>` inside a value and an arrow in a handler.
    const decoy = [
      '<span class="a" aria-label="dropped">✓</span>',
      '<div title="a > b" aria-label="also dropped"><span>x</span></div>',
      '<div onClick={() => close()} aria-label="dropped too" />',
      // A role that removes the element cannot also name it; skipping anything
      // with a `role=` at all let this shape through.
      '<div role="presentation" aria-label="dropped by presentation" />',
      '<span role="none" aria-label="dropped by none">✓</span>',
      '<span role="generic" aria-label="dropped by generic">✓</span>',
      '<span role="img" aria-label="kept">✓</span>',
      '<div role={rowRole} aria-label="kept, role unevaluated" />',
      '<div class="plain">text</div>',
      '<p aria-labelledby="heading">text</p>',
    ].join("\n");
    const found = [...decoy.matchAll(NAMEABLE_BY_ROLE_ONLY)]
      .map((match) => attributesOfTag(decoy, match.index + match[0].length))
      .filter(dropsItsName)
      .map((attributes) => nameAttribute(attributes));
    expect(found).toEqual([
      'aria-label="dropped"',
      'aria-label="also dropped"',
      'aria-label="dropped too"',
      'aria-label="dropped by presentation"',
      'aria-label="dropped by none"',
      'aria-label="dropped by generic"',
      'aria-label="heading"',
    ]);
  });

  /*
   * The pardon list is a mechanism, and an unexercised mechanism is where the
   * next silent admission hides. Both halves are checked here rather than by
   * waiting for a real second offender: a repeated label is not covered by one
   * entry, and an entry nobody spends is a failure, not a no-op.
   */
  it("spends each pardon once and fails on one that has nothing left to pardon", () => {
    const pardons = new Map([["f.tsx :: a", 1], ["f.tsx :: gone", 1]]);
    const unspent = new Map(pardons);
    const offenders: string[] = [];
    for (const record of ["f.tsx :: a", "f.tsx :: a", "f.tsx :: b"]) {
      const excused = unspent.get(record) ?? 0;
      if (excused > 0) unspent.set(record, excused - 1);
      else offenders.push(record);
    }
    // The second identical label is not covered by the first one's entry.
    expect(offenders).toEqual(["f.tsx :: a", "f.tsx :: b"]);
    // And the entry for a container that has since been fixed is reported.
    expect([...unspent].flatMap(([record, left]) => (left > 0 ? [record] : []))).toEqual(["f.tsx :: gone"]);
  });
});

/*
 * The same defect on a control rather than a container: `aria-label` on a
 * `<button>` does name it, but it *replaces* the name the contents would
 * compute. MenuSelect's trigger once named itself by the field label alone,
 * so the visible value — the only text a non-compact trigger shows — reached
 * no name a voice user could call the control by (WCAG 2.5.3), a screen
 * reader never announced what was chosen, and the compact monogram carried
 * no value information at all. Its options compressed label + description
 * into label alone the same way. The contract going forward: the trigger is
 * named label + value from its own contents, and an option is named from its
 * contents so the description is never hidden.
 */
/*
 * The name is the field; the value and the description are descriptions.
 *
 * This block first pinned the opposite — name computed from contents, so the
 * trigger announced "Color mode Dark instrument" and an option announced its
 * label plus a whole sentence. That fixed a real defect (an `aria-label` had
 * been hiding the chosen value from readers entirely) and introduced a worse
 * one: a control can no longer be called by the thing it sets. That is the name
 * a voice user speaks, and it is how every surface in the product refers to
 * these controls — eight browser journeys could not find them once the value
 * joined the name.
 *
 * ARIA already has the right slot for both. `aria-describedby` is announced
 * after the name, so nothing is hidden: the trigger says "Color mode", then
 * "Dark instrument"; an option says "Auto Approve", then its sentence. That is
 * also what the APG listbox pattern asks for — an option's name is its label,
 * and supplementary prose is a description, not part of the name.
 */
describe("menu-select names its controls by their field, and describes the rest", () => {
  const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");

  /** The attribute text of the first tag whose class marks it. */
  function attributesOfComponentTag(marker: string): string {
    const start = source.indexOf(`<button`);
    let cursor = start;
    while (cursor >= 0) {
      const attributes = attributesOfTag(source, cursor + "<button".length);
      if (attributes.includes(marker)) return attributes;
      cursor = source.indexOf("<button", cursor + 1);
    }
    throw new Error(`no button carries ${marker}`);
  }

  it("names the trigger by the field it sets, and describes the current value", () => {
    const attributes = attributesOfComponentTag("menu-select-trigger");
    // The field name, so the control is addressable by what it changes.
    expect(attributes).toContain("aria-label={ariaLabel}");
    // The value reaches the reader as a description rather than not at all.
    expect(attributes).toContain("aria-describedby={`${listboxId}-value`}");
    // Visible where there is room for it; hidden text on the compact trigger,
    // where the monogram leaves none — never absent.
    expect(source).toContain('<span class="menu-select-value" id={`${listboxId}-value`}><strong>{selected?.label ?? "Choose"}</strong></span>');
    expect(source).toContain('<span class="sr-only" id={`${listboxId}-value`}><strong>{selected?.label ?? "Choose"}</strong></span>');
  });

  it("names each option by its label, and describes it without hiding the sentence", () => {
    const attributes = attributesOfComponentTag("menu-select-option");
    // No `aria-label`: the label is the option's own content, so the two cannot
    // drift apart the way an overriding attribute let them.
    expect(CARRIES_A_NAME.test(attributes)).toBe(false);
    expect(attributes).toContain("aria-describedby={option.description ? `${listboxId}-${index}-description` : undefined}");
    /*
     * `aria-hidden` on the sentence, and this is the subtle half: a referenced
     * element's text is still used to build a description even when it is
     * hidden, so the sentence is announced — it just stops being folded into
     * the name. `role="presentation"` was tried first and is not enough: it
     * drops the role, not the text.
     */
    expect(source).toContain('<small id={`${listboxId}-${index}-description`} aria-hidden="true">{option.description}</small>');
  });
});
