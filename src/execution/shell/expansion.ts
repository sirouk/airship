import type { Word, WordPart } from "./ast";
import { evaluateArithmetic } from "./arithmetic";
import { AIRSHIP_SH_MAX_EXPANSION_BYTES, AIRSHIP_SH_MAX_GLOB_RESULTS } from "./contract";
import { ShellCommandError } from "./errors";
import type { ShellFileSystem } from "./filesystem";
import { joinPath } from "./filesystem";
import {
  compilePattern,
  matchPattern,
  matchPrefix,
  matchSuffix,
  patternHasWildcard,
  splitSegments,
  type PatternSegment,
} from "./pattern";

/**
 * One expanded chunk of a word plus the only thing a flattened string cannot
 * carry: whether the characters came from a quoted region. Field splitting and
 * pathname expansion apply to unquoted characters only.
 */
export type Segment = PatternSegment;

type Field = { segments: Segment[]; hasContent: boolean };

/** Everything word expansion needs from the running interpreter. */
export interface ExpansionHost {
  readonly fs: ShellFileSystem;
  readonly noglob: boolean;
  readonly nounset: boolean;
  lookup(name: string): string | undefined;
  assign(name: string, value: string): void;
  positional(): readonly string[];
  special(name: string): string | undefined;
  home(): string;
  /** Runs `$(...)`/backquotes and returns stdout with trailing newlines removed. */
  substitute(script: string): Promise<string>;
  charge(steps?: number): void;
}

export async function expandToFields(word: Word, host: ExpansionHost): Promise<readonly string[]> {
  const fields = await expandParts(word, host, true);
  const split = fields.flatMap((field) => splitOnIfs(field, host.lookup("IFS")));
  const surviving = split.filter((field) => field.hasContent || field.segments.some(({ text }) => text.length > 0));
  const result: string[] = [];
  for (const field of surviving) {
    const globbed = host.noglob ? undefined : expandPathname(field.segments, host.fs);
    if (globbed) result.push(...globbed);
    else result.push(field.segments.map(({ text }) => text).join(""));
  }
  return Object.freeze(result);
}

/** For redirect targets, `case` subjects, and assignment values: no splitting. */
export async function expandToString(word: Word, host: ExpansionHost): Promise<string> {
  const fields = await expandParts(word, host, false);
  return fields
    .map((field) => field.segments.map(({ text }) => text).join(""))
    .join(joinCharacter(host.lookup("IFS")));
}

/** Keeps quoting so `case "$x" in \*) ...` matches a literal asterisk. */
export async function expandToPattern(word: Word, host: ExpansionHost): Promise<readonly Segment[]> {
  const fields = await expandParts(word, host, false);
  return Object.freeze(fields.flatMap((field) => field.segments));
}

async function expandParts(word: Word, host: ExpansionHost, splitting: boolean): Promise<Field[]> {
  const fields: Field[] = [{ segments: [], hasContent: false }];
  let expandedCharacters = 0;
  const append = (segment: Segment): void => {
    host.charge();
    expandedCharacters += segment.text.length;
    if (expandedCharacters > AIRSHIP_SH_MAX_EXPANSION_BYTES) {
      throw new ShellCommandError(`word expansion exceeded ${AIRSHIP_SH_MAX_EXPANSION_BYTES} bytes`);
    }
    fields[fields.length - 1].segments.push(segment);
  };
  const mark = (): void => {
    fields[fields.length - 1].hasContent = true;
  };
  const breakField = (): void => {
    fields.push({ segments: [], hasContent: true });
  };

  for (const part of word) {
    host.charge();
    switch (part.kind) {
      case "literal": {
        append(Object.freeze({ text: part.text, quoted: part.quoted }));
        mark();
        break;
      }
      case "tilde": {
        // `~name` without a user database stays literal, exactly as a shell
        // leaves an unknown user untouched. Only bare `~` has a home here.
        if (part.user === "") append(Object.freeze({ text: host.home(), quoted: true }));
        else append(Object.freeze({ text: `~${part.user}`, quoted: false }));
        mark();
        break;
      }
      case "command": {
        const text = await host.substitute(part.script);
        append(Object.freeze({ text, quoted: part.quoted }));
        if (part.quoted) mark();
        break;
      }
      case "arithmetic": {
        const source = await expandToString(part.source, host);
        const value = evaluateArithmetic(source, {
          read: (name) => host.lookup(name),
          assign: (name, next) => host.assign(name, next),
        });
        append(Object.freeze({ text: value.toString(), quoted: part.quoted }));
        mark();
        break;
      }
      case "parameter": {
        await expandParameter(part, host, { append, mark, breakField, splitting });
        break;
      }
    }
  }
  return fields;
}

type ParameterSink = Readonly<{
  append: (segment: Segment) => void;
  mark: () => void;
  breakField: () => void;
  splitting: boolean;
}>;

async function expandParameter(
  part: Extract<WordPart, { kind: "parameter" }>,
  host: ExpansionHost,
  sink: ParameterSink,
): Promise<void> {
  if (part.name === "@" || part.name === "*") {
    const parameters = host.positional();
    if (part.length) {
      sink.append(Object.freeze({ text: String(parameters.length), quoted: part.quoted }));
      sink.mark();
      return;
    }
    if (part.operator !== "none") {
      throw new ShellCommandError(`airship-sh does not implement \${${part.name}${part.operator}} operators`, 2);
    }
    if (part.name === "*" || (!part.quoted && !sink.splitting)) {
      const separator = joinCharacter(host.lookup("IFS"));
      sink.append(Object.freeze({ text: parameters.join(separator), quoted: part.quoted }));
      sink.mark();
      return;
    }
    // `"$@"` is the one expansion that produces several fields on its own, and
    // with no positional parameters it produces none at all.
    parameters.forEach((value, index) => {
      if (index > 0) sink.breakField();
      sink.append(Object.freeze({ text: value, quoted: part.quoted }));
      sink.mark();
    });
    return;
  }

  const raw = readParameter(part.name, host);
  const unset = raw === undefined;
  const empty = unset || raw === "";
  const triggered = part.colon ? empty : unset;

  if (part.length) {
    if (unset && host.nounset) throw new ShellCommandError(`${part.name}: parameter not set`, 1);
    sink.append(Object.freeze({ text: String([...(raw ?? "")].length), quoted: part.quoted }));
    sink.mark();
    return;
  }

  switch (part.operator) {
    case "none": {
      if (unset && host.nounset) throw new ShellCommandError(`${part.name}: parameter not set`, 1);
      sink.append(Object.freeze({ text: raw ?? "", quoted: part.quoted }));
      if (part.quoted) sink.mark();
      return;
    }
    case "use-default": {
      if (!triggered) {
        sink.append(Object.freeze({ text: raw ?? "", quoted: part.quoted }));
        if (part.quoted) sink.mark();
        return;
      }
      await appendWord(part.argument, host, sink, part.quoted);
      return;
    }
    case "assign-default": {
      if (!triggered) {
        sink.append(Object.freeze({ text: raw ?? "", quoted: part.quoted }));
        if (part.quoted) sink.mark();
        return;
      }
      const value = part.argument ? await expandToString(part.argument, host) : "";
      host.assign(part.name, value);
      sink.append(Object.freeze({ text: value, quoted: part.quoted }));
      sink.mark();
      return;
    }
    case "error-if-unset": {
      if (!triggered) {
        sink.append(Object.freeze({ text: raw ?? "", quoted: part.quoted }));
        if (part.quoted) sink.mark();
        return;
      }
      const message = part.argument ? await expandToString(part.argument, host) : "";
      throw new ShellCommandError(`${part.name}: ${message || "parameter null or not set"}`, 1);
    }
    case "alternative": {
      if (triggered) return;
      await appendWord(part.argument, host, sink, part.quoted);
      return;
    }
    default: {
      const pattern = compilePattern(part.argument ? await expandToPattern(part.argument, host) : []);
      const value = raw ?? "";
      const trimmed = trimByPattern(part.operator, pattern, value);
      sink.append(Object.freeze({ text: trimmed, quoted: part.quoted }));
      if (part.quoted) sink.mark();
    }
  }
}

async function appendWord(
  word: Word | undefined,
  host: ExpansionHost,
  sink: ParameterSink,
  quoted: boolean,
): Promise<void> {
  if (!word || word.length === 0) {
    if (quoted) sink.mark();
    return;
  }
  const fields = await expandParts(word, host, sink.splitting);
  fields.forEach((field, index) => {
    if (index > 0) sink.breakField();
    for (const segment of field.segments) {
      sink.append(Object.freeze({ text: segment.text, quoted: quoted || segment.quoted }));
    }
    if (field.hasContent || quoted) sink.mark();
  });
}

function trimByPattern(
  operator: Extract<WordPart, { kind: "parameter" }>["operator"],
  pattern: ReturnType<typeof compilePattern>,
  value: string,
): string {
  const characters = [...value];
  if (operator === "remove-smallest-prefix" || operator === "remove-largest-prefix") {
    const length = matchPrefix(pattern, value, operator === "remove-largest-prefix");
    return length <= 0 ? value : characters.slice(length).join("");
  }
  const length = matchSuffix(pattern, value, operator === "remove-largest-suffix");
  return length <= 0 ? value : characters.slice(0, characters.length - length).join("");
}

function readParameter(name: string, host: ExpansionHost): string | undefined {
  if (/^[0-9]+$/u.test(name)) {
    if (name === "0") return host.special("0");
    return host.positional()[Number.parseInt(name, 10) - 1];
  }
  const special = host.special(name);
  if (special !== undefined) return special;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return host.lookup(name);
  return undefined;
}

function joinCharacter(ifs: string | undefined): string {
  const value = ifs ?? " \t\n";
  return value.length === 0 ? "" : [...value][0];
}

function splitOnIfs(field: Field, ifs: string | undefined): Field[] {
  const separators = ifs ?? " \t\n";
  if (separators.length === 0) return [field];
  const whitespace = new Set<string>([...separators].filter((char) => char === " " || char === "\t" || char === "\n"));
  const explicit = new Set<string>([...separators].filter((char) => !whitespace.has(char)));
  const result: Field[] = [];
  let current: Segment[] = [];
  let buffer = "";
  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      current.push(Object.freeze({ text: buffer, quoted: false }));
      buffer = "";
    }
  };
  const closeField = (force: boolean): void => {
    flushBuffer();
    if (force || current.length > 0) {
      result.push({ segments: current, hasContent: true });
      current = [];
    }
  };
  for (const segment of field.segments) {
    if (segment.quoted) {
      flushBuffer();
      current.push(segment);
      continue;
    }
    for (const char of segment.text) {
      if (whitespace.has(char)) {
        closeField(false);
        continue;
      }
      if (explicit.has(char)) {
        closeField(true);
        continue;
      }
      buffer += char;
    }
  }
  flushBuffer();
  if (current.length > 0) result.push({ segments: current, hasContent: true });
  if (result.length === 0) return [{ segments: [], hasContent: field.hasContent }];
  return result;
}

/**
 * Pathname expansion against the real mounted filesystem. An unmatched pattern
 * stays literal, exactly as POSIX requires, and a pattern that would return
 * more than the cap fails the run instead of quietly returning a prefix.
 */
function expandPathname(segments: readonly Segment[], fs: ShellFileSystem): readonly string[] | undefined {
  const components = splitSegments(segments, "/");
  const patterns = components.map((component) => compilePattern(component));
  if (!patterns.some((pattern) => patternHasWildcard(pattern))) return undefined;
  const joined = segments.map(({ text }) => text).join("");
  const absolute = joined.startsWith("/");
  const start = absolute ? "/" : fs.cwd;
  const parts = absolute ? components.slice(1) : components;
  const patternParts = absolute ? patterns.slice(1) : patterns;
  let frontier: string[] = [start];
  for (const [index, pattern] of patternParts.entries()) {
    const literal = !patternHasWildcard(pattern);
    const next: string[] = [];
    for (const directory of frontier) {
      if (!fs.isDirectory(directory)) continue;
      if (literal) {
        const name = parts[index].map(({ text }) => text).join("");
        if (name === "" || name === ".") {
          next.push(directory);
          continue;
        }
        if (name === "..") {
          next.push(fs.resolve(joinPath(directory, "..")));
          continue;
        }
        const candidate = joinPath(directory, name);
        if (fs.exists(candidate)) next.push(candidate);
        continue;
      }
      for (const name of fs.list(directory)) {
        if (!matchPattern(pattern, name, { periodGuard: true })) continue;
        next.push(joinPath(directory, name));
        if (next.length > AIRSHIP_SH_MAX_GLOB_RESULTS) {
          throw new ShellCommandError(`pathname expansion exceeded ${AIRSHIP_SH_MAX_GLOB_RESULTS} matches`);
        }
      }
    }
    frontier = next;
  }
  if (frontier.length === 0) return undefined;
  const relative = absolute
    ? frontier
    : frontier.map((path) => (path === fs.cwd ? "." : path.slice(fs.cwd === "/" ? 1 : fs.cwd.length + 1)));
  return Object.freeze([...new Set(relative)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
}
