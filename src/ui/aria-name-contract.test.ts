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
 * `src/ui/app.tsx` is being edited concurrently in this same audit pass, so its
 * four containers are recorded here instead of touched. None of them is a lost
 * fact — each wraps text that is announced on its own — and each is one
 * `role="group"` away from clean. Delete an entry as it is fixed; a fifth
 * unnamed container in that file still fails this test.
 */
const AWAITING_A_CONCURRENT_EDIT: ReadonlySet<string> = new Set([
  'src/ui/app.tsx :: aria-label="Runtime state"',
  'src/ui/app.tsx :: aria-label="Queued messages"',
  'src/ui/app.tsx :: aria-label="Pending attachments"',
  'src/ui/app.tsx :: aria-label="Durable turn disposition"',
]);

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

describe("every ARIA name lands on an element allowed to have one", () => {
  it("finds no div, span or p named without a role", async () => {
    const root = new URL("../../", import.meta.url);
    const offenders: string[] = [];
    for await (const file of componentFiles(new URL("src/", root))) {
      const relative = file.pathname.slice(root.pathname.length);
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(NAMEABLE_BY_ROLE_ONLY)) {
        const start = match.index + match[0].length;
        const attributes = attributesOfTag(source, start);
        if (!CARRIES_A_NAME.test(attributes) || CARRIES_A_ROLE.test(attributes)) continue;
        const record = `${relative} :: ${nameAttribute(attributes)}`;
        if (AWAITING_A_CONCURRENT_EDIT.has(record)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${relative}:${line}: ${record}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sees a name on a bare container that a role would hide from it", () => {
    // The scanner is the whole guarantee, so it is exercised on markup shaped
    // like the defect it exists to catch — including the two shapes that broke
    // naive regex attempts: a `>` inside a value and an arrow in a handler.
    const decoy = [
      '<span class="a" aria-label="dropped">✓</span>',
      '<div title="a > b" aria-label="also dropped"><span>x</span></div>',
      '<div onClick={() => close()} aria-label="dropped too" />',
      '<span role="img" aria-label="kept">✓</span>',
      '<div class="plain">text</div>',
      '<p aria-labelledby="heading">text</p>',
    ].join("\n");
    const found = [...decoy.matchAll(NAMEABLE_BY_ROLE_ONLY)]
      .map((match) => attributesOfTag(decoy, match.index + match[0].length))
      .filter((attributes) => CARRIES_A_NAME.test(attributes) && !CARRIES_A_ROLE.test(attributes))
      .map((attributes) => nameAttribute(attributes));
    expect(found).toEqual([
      'aria-label="dropped"',
      'aria-label="also dropped"',
      'aria-label="dropped too"',
      'aria-label="heading"',
    ]);
  });
});
