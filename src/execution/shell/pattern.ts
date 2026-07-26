/**
 * POSIX pattern matching (`fnmatch`-class), used by pathname expansion, `case`
 * patterns, and the `#`/`%` parameter trimming operators.
 *
 * The matcher is a hand-written scanner rather than a translation to `RegExp`
 * on purpose: shell patterns come from script text that this engine does not
 * control, and a translated pattern with nested quantifiers can backtrack
 * catastrophically. The single-star backtracking below is O(text × pattern).
 */

export type PatternSegment = Readonly<{ text: string; quoted: boolean }>;

export type PatternItem =
  | Readonly<{ kind: "literal"; char: string }>
  | Readonly<{ kind: "any" }>
  | Readonly<{ kind: "star" }>
  | Readonly<{ kind: "class"; negated: boolean; members: readonly ClassMember[] }>;

type ClassMember =
  | Readonly<{ kind: "char"; char: string }>
  | Readonly<{ kind: "range"; from: string; to: string }>
  | Readonly<{ kind: "named"; name: CharacterClassName }>;

type CharacterClassName = keyof typeof CHARACTER_CLASSES;

const CHARACTER_CLASSES = Object.freeze({
  alpha: /^\p{L}$/u,
  digit: /^[0-9]$/u,
  alnum: /^[\p{L}0-9]$/u,
  space: /^\s$/u,
  upper: /^\p{Lu}$/u,
  lower: /^\p{Ll}$/u,
  punct: /^[!-/:-@[-`{-~]$/u,
  xdigit: /^[0-9A-Fa-f]$/u,
  blank: /^[ \t]$/u,
  cntrl: /^[\u0000-\u001f\u007f]$/u,
  print: /^[^\u0000-\u001f\u007f]$/u,
  graph: /^[^\u0000-\u0020\u007f]$/u,
});

/** Flattens segments to their literal text, discarding pattern meaning. */
export function segmentsToText(segments: readonly PatternSegment[]): string {
  return segments.map(({ text }) => text).join("");
}

export function compilePattern(segments: readonly PatternSegment[]): readonly PatternItem[] {
  const characters: { char: string; quoted: boolean }[] = [];
  for (const segment of segments) {
    for (const char of segment.text) characters.push({ char, quoted: segment.quoted });
  }
  const items: PatternItem[] = [];
  let index = 0;
  while (index < characters.length) {
    const current = characters[index];
    if (current.quoted) {
      items.push(Object.freeze({ kind: "literal", char: current.char }));
      index += 1;
      continue;
    }
    if (current.char === "*") {
      if (items[items.length - 1]?.kind !== "star") items.push(Object.freeze({ kind: "star" }));
      index += 1;
      continue;
    }
    if (current.char === "?") {
      items.push(Object.freeze({ kind: "any" }));
      index += 1;
      continue;
    }
    if (current.char === "[") {
      const bracket = readBracket(characters, index);
      if (bracket) {
        items.push(bracket.item);
        index = bracket.next;
        continue;
      }
    }
    items.push(Object.freeze({ kind: "literal", char: current.char }));
    index += 1;
  }
  return Object.freeze(items);
}

export function patternHasWildcard(items: readonly PatternItem[]): boolean {
  return items.some((item) => item.kind !== "literal");
}

export function matchPattern(
  items: readonly PatternItem[],
  text: string,
  options: Readonly<{ periodGuard?: boolean }> = {},
): boolean {
  const characters = [...text];
  if (options.periodGuard === true && characters[0] === ".") {
    const leading = items[0];
    if (!leading || leading.kind !== "literal" || leading.char !== ".") return false;
  }
  let itemIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starText = 0;
  while (textIndex < characters.length) {
    const item = items[itemIndex];
    if (item && item.kind !== "star" && matchOne(item, characters[textIndex])) {
      itemIndex += 1;
      textIndex += 1;
      continue;
    }
    if (item && item.kind === "star") {
      starIndex = itemIndex;
      starText = textIndex;
      itemIndex += 1;
      continue;
    }
    if (starIndex !== -1) {
      itemIndex = starIndex + 1;
      starText += 1;
      textIndex = starText;
      continue;
    }
    return false;
  }
  while (itemIndex < items.length && items[itemIndex].kind === "star") itemIndex += 1;
  return itemIndex === items.length;
}

/**
 * Splits pattern segments on an unquoted separator so pathname expansion can
 * match one directory component at a time. A quoted `/` stays literal.
 */
export function splitSegments(segments: readonly PatternSegment[], separator: string): readonly (readonly PatternSegment[])[] {
  const groups: PatternSegment[][] = [[]];
  for (const segment of segments) {
    if (segment.quoted) {
      groups[groups.length - 1].push(segment);
      continue;
    }
    const pieces = segment.text.split(separator);
    pieces.forEach((piece, index) => {
      if (index > 0) groups.push([]);
      if (piece.length > 0) groups[groups.length - 1].push(Object.freeze({ text: piece, quoted: false }));
    });
  }
  return Object.freeze(groups.map((group) => Object.freeze(group)));
}

/** Longest or shortest prefix of `text` matched by the pattern, or -1. */
export function matchPrefix(items: readonly PatternItem[], text: string, longest: boolean): number {
  const characters = [...text];
  const range = [...characters.keys(), characters.length];
  const candidates = longest ? [...range].reverse() : range;
  for (const length of candidates) {
    if (matchPattern(items, characters.slice(0, length).join(""))) return length;
  }
  return -1;
}

/** Longest or shortest suffix of `text` matched by the pattern, or -1. */
export function matchSuffix(items: readonly PatternItem[], text: string, longest: boolean): number {
  const characters = [...text];
  const range = [...characters.keys(), characters.length];
  const candidates = longest ? [...range].reverse() : range;
  for (const length of candidates) {
    if (matchPattern(items, characters.slice(characters.length - length).join(""))) return length;
  }
  return -1;
}

function matchOne(item: PatternItem, char: string): boolean {
  switch (item.kind) {
    case "literal":
      return item.char === char;
    case "any":
      return true;
    case "star":
      return false;
    case "class": {
      const inside = item.members.some((member) => matchMember(member, char));
      return item.negated ? !inside : inside;
    }
  }
}

function matchMember(member: ClassMember, char: string): boolean {
  switch (member.kind) {
    case "char":
      return member.char === char;
    case "range":
      return char >= member.from && char <= member.to;
    case "named":
      return CHARACTER_CLASSES[member.name].test(char);
  }
}

function readBracket(
  characters: readonly { char: string; quoted: boolean }[],
  start: number,
): Readonly<{ item: PatternItem; next: number }> | undefined {
  let index = start + 1;
  let negated = false;
  if (index < characters.length && !characters[index].quoted && (characters[index].char === "!" || characters[index].char === "^")) {
    negated = true;
    index += 1;
  }
  const members: ClassMember[] = [];
  let first = true;
  while (index < characters.length) {
    const current = characters[index];
    if (current.char === "]" && !current.quoted && !first) {
      return Object.freeze({
        item: Object.freeze({ kind: "class", negated, members: Object.freeze(members) }),
        next: index + 1,
      });
    }
    first = false;
    if (current.char === "[" && !current.quoted && characters[index + 1]?.char === ":") {
      const close = findNamedClassEnd(characters, index + 2);
      if (close !== undefined) {
        const name = characters
          .slice(index + 2, close)
          .map(({ char }) => char)
          .join("");
        if (name in CHARACTER_CLASSES) {
          members.push(Object.freeze({ kind: "named", name: name as CharacterClassName }));
          index = close + 2;
          continue;
        }
      }
    }
    const next = characters[index + 1];
    const after = characters[index + 2];
    if (next && next.char === "-" && !next.quoted && after && !(after.char === "]" && !after.quoted)) {
      members.push(Object.freeze({ kind: "range", from: current.char, to: after.char }));
      index += 3;
      continue;
    }
    members.push(Object.freeze({ kind: "char", char: current.char }));
    index += 1;
  }
  // An unterminated bracket is a literal `[`, exactly as POSIX requires.
  return undefined;
}

function findNamedClassEnd(characters: readonly { char: string; quoted: boolean }[], from: number): number | undefined {
  for (let index = from; index + 1 < characters.length; index += 1) {
    if (characters[index].char === ":" && characters[index + 1].char === "]") return index;
    if (characters[index].char === "]") return undefined;
  }
  return undefined;
}
