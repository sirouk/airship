import { ShellCommandError } from "./errors";

/**
 * POSIX basic and extended regular expressions, translated to `RegExp`.
 *
 * Two things are deliberately explicit. First, back-references and the GNU
 * `\<`/`\>` word delimiters are translated rather than assumed compatible.
 * Second, matching is bounded: a pattern from a script can backtrack badly, so
 * callers cap the subject length instead of pretending the risk is absent.
 */
export const REGEX_MAX_SUBJECT_LENGTH = 64 * 1_024;

const NAMED_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
});

export type RegexOptions = Readonly<{
  extended?: boolean;
  fixed?: boolean;
  ignoreCase?: boolean;
  wholeWord?: boolean;
  wholeLine?: boolean;
  global?: boolean;
}>;

export function compileRegex(pattern: string, options: RegexOptions = {}): RegExp {
  let source = options.fixed === true ? escapeLiteral(pattern) : translate(pattern, options.extended === true);
  if (options.wholeWord === true) source = `\\b(?:${source})\\b`;
  if (options.wholeLine === true) source = `^(?:${source})$`;
  const flags = `u${options.ignoreCase === true ? "i" : ""}${options.global === true ? "g" : ""}`;
  try {
    return new RegExp(source, flags);
  } catch {
    // Retry without Unicode mode: POSIX bracket expressions accept some
    // sequences that `u` mode rejects, and failing the command with an
    // unhelpful "invalid regexp" would hide the real cause.
    try {
      return new RegExp(source, options.ignoreCase === true ? "i" : options.global === true ? "g" : "");
    } catch {
      throw new ShellCommandError(`invalid regular expression: ${pattern}`, 2);
    }
  }
}

export function assertBoundedSubject(text: string): void {
  if (text.length > REGEX_MAX_SUBJECT_LENGTH) {
    throw new ShellCommandError(`input line exceeds the ${REGEX_MAX_SUBJECT_LENGTH}-character regular-expression limit`);
  }
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/**
 * Translates one POSIX regular expression into JavaScript syntax.
 *
 * In a basic regular expression `(`, `)`, `{`, `}`, `|`, `+`, and `?` are
 * literal unless backslash-escaped — the exact inverse of JavaScript — so the
 * translation swaps them rather than hoping the two dialects agree.
 */
function translate(pattern: string, extended: boolean): string {
  let output = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1];
      index += 2;
      if (next === undefined) {
        output += "\\\\";
        continue;
      }
      if (next === "<" || next === ">") {
        output += "\\b";
        continue;
      }
      if (!extended && "(){}|+?".includes(next)) {
        output += next;
        continue;
      }
      if (extended && "(){}|+?".includes(next)) {
        output += `\\${next}`;
        continue;
      }
      output += /^[0-9A-Za-z]$/u.test(next) ? `\\${next}` : escapeLiteral(next);
      continue;
    }
    if (char === "[") {
      const bracket = translateBracket(pattern, index);
      output += bracket.source;
      index = bracket.next;
      continue;
    }
    if (!extended && "(){}|+?".includes(char)) {
      output += `\\${char}`;
      index += 1;
      continue;
    }
    if (char === "/") {
      output += "\\/";
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function translateBracket(pattern: string, start: number): Readonly<{ source: string; next: number }> {
  let index = start + 1;
  let body = "";
  if (pattern[index] === "^") {
    body += "^";
    index += 1;
  }
  if (pattern[index] === "]") {
    body += "\\]";
    index += 1;
  }
  while (index < pattern.length && pattern[index] !== "]") {
    if (pattern.startsWith("[:", index)) {
      const close = pattern.indexOf(":]", index + 2);
      const name = close === -1 ? "" : pattern.slice(index + 2, close);
      const expansion = NAMED_CLASSES[name];
      if (expansion === undefined) throw new ShellCommandError(`unsupported character class: [:${name}:]`, 2);
      body += expansion;
      index = close + 2;
      continue;
    }
    const char = pattern[index];
    body += char === "\\" || char === "]" || char === "^" ? `\\${char}` : char;
    index += 1;
  }
  if (index >= pattern.length) throw new ShellCommandError(`unterminated bracket expression: ${pattern}`, 2);
  return Object.freeze({ source: `[${body}]`, next: index + 1 });
}
