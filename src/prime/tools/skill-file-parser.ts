/**
 * SKILL.md frontmatter parser for the prime skills system.
 *
 * Upstream (packages/coding-agent/src/core/skills.ts +
 * utils/frontmatter.ts) parses frontmatter with the full `yaml` package
 * and keeps unknown keys. The port deliberately parses a bounded subset
 * instead: frontmatter is model-facing hostile input (it lands verbatim
 * in the skills prompt block), and pulling a full YAML engine into the
 * browser bundle to accept every YAML 1.2 exotic is the exact trade the
 * honesty rules argue against — an input the subset cannot represent is
 * REJECTED with a named issue, never silently coerced.
 *
 * Supported subset (the shape every skill Prime Agent ships, plus the
 * Agent Skills spec fields):
 *   - `key: value` mappings at any consistent top-level indent;
 *   - plain, single-quoted ('' escape), and double-quoted (\x/\u/\U
 *     hex and the usual short escapes) scalars;
 *   - block scalars `|` and `>` with `-`/`+` chomping (indentation
 *     indicators like `|2` are NOT in the subset);
 *   - inline flow lists `[a, "b, c"]` on one line, and dash lists
 *       key:
 *         - a
 *         - b
 *   - one nesting level of `key: value` mappings (used by `env`);
 *   - plain-scalar line folding (a more-indented continuation joins the
 *     scalar with a space; runs separated by a blank line join with a
 *     newline — YAML's paragraph rule).
 *
 * Key normalization: `allowed-tools` / `allowed_tools` / `allowedTools`
 * (and the same family for `load-context`, `disable-model-invocation`)
 * normalize onto the camelCase field. Unknown keys are kept OUT of the
 * typed frontmatter and reported as `unsupported_key` warnings — upstream
 * smuggled them through its open index signature; the port names and
 * drops them because nothing downstream consumes them here.
 *
 * The parser NEVER throws. Every malformed input lands in `issues` with
 * a named code, a severity, a field, and a 1-based line inside the
 * frontmatter block, and parse-produced values are always returned in a
 * defined shape. Severity follows upstream's effective outcome:
 * upstream's "warning, skill kept" cases are warnings here; the cases
 * where upstream's YAML parse threw (or its description gate dropped the
 * skill) are errors, because the registry must not name a skill from a
 * poisoned source.
 */

export const MAX_SKILL_MD_CHARS = 128 * 1_024;
/** Agent Skills spec cap, upstream MAX_NAME_LENGTH. */
export const MAX_SKILL_NAME_CHARS = 64;
/** Agent Skills spec cap, upstream MAX_DESCRIPTION_LENGTH. */
export const MAX_SKILL_DESCRIPTION_CHARS = 1_024;
/** Port cap; version is display metadata, bounded against prompt bloat. */
export const MAX_SKILL_VERSION_CHARS = 64;
/** Port cap on the author line. */
export const MAX_SKILL_AUTHOR_CHARS = 256;
/** Per-list cap for allowed-tools / load-context. */
export const MAX_SKILL_LIST_ITEMS = 32;
/** Per-item cap inside those lists. */
export const MAX_SKILL_LIST_ITEM_CHARS = 256;
/** env is a bounded flat map. */
export const MAX_SKILL_ENV_ENTRIES = 32;
export const MAX_SKILL_ENV_KEY_CHARS = 64;
export const MAX_SKILL_ENV_VALUE_CHARS = 512;

export const PRIME_SKILL_FILE_ISSUE_CODES = Object.freeze([
  "skill_md_too_large",
  "frontmatter_unterminated",
  "frontmatter_not_mapping",
  "line_malformed",
  "duplicate_key",
  "unsupported_key",
  "nested_value_unsupported",
  "quoted_unterminated",
  "escape_unknown",
  "block_scalar_bad_header",
  "inline_list_malformed",
  "list_item_malformed",
  "list_too_many_items",
  "list_item_length_exceeded",
  "name_missing",
  "name_not_string",
  "name_length_exceeded",
  "name_invalid_characters",
  "name_leading_trailing_hyphen",
  "name_consecutive_hyphens",
  "name_parent_dir_mismatch",
  "description_missing",
  "description_not_string",
  "description_length_exceeded",
  "version_not_string",
  "version_length_exceeded",
  "author_not_string",
  "author_length_exceeded",
  "env_not_mapping",
  "env_key_invalid",
  "env_key_length_exceeded",
  "env_value_not_string",
  "env_value_length_exceeded",
  "env_too_many_entries",
  "allowed_tools_not_list",
  "load_context_not_list",
  "disable_model_invocation_not_boolean",
] as const);

export type PrimeSkillFileIssueCode = (typeof PRIME_SKILL_FILE_ISSUE_CODES)[number];

export type PrimeSkillFileIssue = Readonly<{
  code: PrimeSkillFileIssueCode;
  severity: "error" | "warning";
  message: string;
  /** Frontmatter field the issue is attached to, when one applies. */
  field?: string;
  /** 1-based line inside the frontmatter block (delimiters excluded), when known. */
  line?: number;
}>;

export type PrimeSkillFrontmatter = Readonly<{
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  env?: Readonly<Record<string, string>>;
  allowedTools?: readonly string[];
  loadContext?: readonly string[];
  disableModelInvocation?: boolean;
}>;

export type ParsedSkillMd = Readonly<{
  /**
   * Typed frontmatter. `undefined` when no frontmatter section exists or
   * the opening fence was never closed — the two states upstream folds
   * into an empty record and the port keeps distinguishable because the
   * remedies differ.
   */
  frontmatter: PrimeSkillFrontmatter | undefined;
  /** Skill instructions. Trimmed when a frontmatter block was consumed, raw otherwise (upstream parity). */
  body: string;
  issues: readonly PrimeSkillFileIssue[];
}>;

type RawScalar = Readonly<{ text: string; quoted: boolean }>;

type RawValue =
  | Readonly<{ kind: "scalar"; scalar: RawScalar }>
  | Readonly<{ kind: "list"; items: readonly RawScalar[] }>
  | Readonly<{ kind: "mapping"; entries: readonly RawEntry[] }>;

type RawEntry = Readonly<{ key: string; value: RawValue; line: number }>;

const scalarValue = (text: string, quoted = false): RawValue =>
  Object.freeze({ kind: "scalar" as const, scalar: Object.freeze({ text, quoted }) });

const listValue = (items: readonly RawScalar[]): RawValue =>
  Object.freeze({ kind: "list" as const, items });

const mappingValue = (entries: readonly RawEntry[]): RawValue =>
  Object.freeze({ kind: "mapping" as const, entries });

const KEY_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*:(?:[ \t]+(.*))?$/;
/** YAML 1.2 core-schema booleans; `yes`/`on` are strings there, so they are strings here. */
const BOOLEAN_TRUE = new Set(["true", "True", "TRUE"]);
const BOOLEAN_FALSE = new Set(["false", "False", "FALSE"]);
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCK_HEADER = /^[|>]([+-])?$/;

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function indentOf(line: string): number {
  let indent = 0;
  while (indent < line.length && line[indent] === " ") indent += 1;
  return indent;
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

interface Sink {
  issues: PrimeSkillFileIssue[];
}

function addIssue(
  sink: Sink,
  code: PrimeSkillFileIssueCode,
  severity: "error" | "warning",
  message: string,
  at: Readonly<{ field?: string; line?: number }> = {},
): void {
  sink.issues.push(Object.freeze({ code, severity, message, ...(at.field !== undefined ? { field: at.field } : {}), ...(at.line !== undefined ? { line: at.line } : {}) }));
}

/**
 * Scan a quoted scalar starting at `start`. Returns the unquoted value
 * and the index one past the closing quote, or undefined when the quote
 * never closes on this line (a `quoted_unterminated` issue is recorded).
 * Single quotes escape as doubled `''`; double quotes take the backslash
 * map plus \xHH / \uHHHH / \UHHHHHHHH, with unknown escapes kept
 * verbatim under an `escape_unknown` warning.
 */
function scanQuoted(text: string, start: number, sink: Sink, line: number): { value: string; end: number } | undefined {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      const simple: Record<string, string> = {
        "0": "\0", a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\u000b",
        f: "\f", r: "\r", e: "\u001b", '"': '"', "'": "'", "\\": "\\",
        "/": "/", " ": " ", _: "\u00a0", N: "\u0085", L: "\u2028", P: "\u2029",
      };
      if (simple[next] !== undefined) {
        out += simple[next];
        i += 2;
        continue;
      }
      const hexLength = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
      if (hexLength > 0) {
        const hex = text.slice(i + 2, i + 2 + hexLength);
        if (hex.length === hexLength && /^[0-9a-fA-F]+$/.test(hex)) {
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2 + hexLength;
          continue;
        }
      }
      addIssue(sink, "escape_unknown", "warning", `unknown escape sequence "\\${next}" in a double-quoted scalar; keeping "${next}" verbatim.`, { line });
      out += next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  addIssue(sink, "quoted_unterminated", "error", `quoted scalar opened at column ${String(start + 1)} never closes on this line.`, { line });
  return undefined;
}

/** Trailing text after a closing quote (or `]`): only whitespace or a ` #` comment may follow. */
function remainderClean(text: string, index: number): boolean {
  const rest = text.slice(index).trim();
  return rest === "" || rest.startsWith("#");
}

/** Strip a trailing ` #` comment from a plain scalar (YAML's space-before-# rule). */
function stripPlainComment(text: string): string {
  const cut = text.indexOf(" #");
  return (cut >= 0 ? text.slice(0, cut) : text).trimEnd();
}

/**
 * Parse an inline flow list `[a, "b, c", 'd']` that must open and close
 * on the same line (multi-line flow is outside the subset). Quoted items
 * may carry commas and nested opposite quotes; empty items name
 * themselves via `list_item_malformed`.
 */
function parseInlineList(text: string, sink: Sink, line: number): RawValue | undefined {
  const items: RawScalar[] = [];
  let i = 1;
  let buf = "";
  let bufQuoted = false;
  const take = (): Readonly<{ text: string; quoted: boolean }> => {
    const taken = Object.freeze({ text: bufQuoted ? buf : buf.trim(), quoted: bufQuoted });
    buf = "";
    bufQuoted = false;
    return taken;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ",") {
      const item = take();
      if (item.text === "") {
        addIssue(sink, "list_item_malformed", "warning", "empty item inside an inline list; the item was skipped.", { line });
      } else {
        items.push(item);
      }
      i += 1;
      continue;
    }
    if (ch === "]") {
      const item = take();
      if (item.text !== "") items.push(item);
      if (!remainderClean(text, i + 1)) {
        addIssue(sink, "line_malformed", "error", "content other than a comment follows the closing ] of an inline list.", { line });
        return undefined;
      }
      return listValue(items);
    }
    if (ch === '"' || ch === "'") {
      const scanned = scanQuoted(text, i, sink, line);
      if (!scanned) return undefined;
      if (!bufQuoted && buf.trim() === "") {
        buf = "";
        bufQuoted = true;
      }
      buf += scanned.value;
      i = scanned.end;
      continue;
    }
    buf += ch;
    i += 1;
  }
  addIssue(sink, "inline_list_malformed", "warning", "inline list never closes with ] on its line; multi-line flow lists are outside the SKILL.md subset — use a dash list.", { line });
  return undefined;
}

interface LineCursor {
  lines: readonly string[];
  i: number;
}

/** Advance past blank / indented lines belonging to a block opened under `parentIndent`. */
function blockEnd(cursor: LineCursor, parentIndent: number): number {
  let end = cursor.i;
  while (end < cursor.lines.length) {
    const line = cursor.lines[end];
    if (isBlank(line) || indentOf(line) > parentIndent) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}

/** YAML plain/block folding: within a paragraph join with a space; paragraphs (blank-line separated) join with \n. */
function foldLines(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const raw of lines) {
    if (isBlank(raw)) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(raw.trim());
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

function applyChomping(text: string, chomp: "+" | "-" | undefined, hadLines: boolean): string {
  if (!hadLines) return "";
  if (chomp === "-") return text.replace(/\n+$/u, "");
  if (chomp === "+") return `${text}\n`;
  const clipped = text.replace(/\n+$/u, "");
  return clipped === "" ? "" : `${clipped}\n`;
}

function parseBlockScalar(
  style: "|" | ">",
  chomp: "+" | "-" | undefined,
  cursor: LineCursor,
  parentIndent: number,
): RawScalar {
  const end = blockEnd(cursor, parentIndent);
  const block = cursor.lines.slice(cursor.i, end);
  cursor.i = end;
  const indents = block.filter((line) => !isBlank(line)).map(indentOf);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  const stripped = block.map((line) => (isBlank(line) ? "" : line.slice(strip)));
  while (stripped.length > 0 && stripped[0] === "") stripped.shift();
  const body = style === "|" ? stripped.join("\n") : foldLines(stripped);
  const hadLines = indents.length > 0;
  return Object.freeze({ text: applyChomping(body, chomp, hadLines), quoted: false });
}

function parseMapping(cursor: LineCursor, sink: Sink, depth: number): RawEntry[] {
  const entries: RawEntry[] = [];
  let minIndent: number | undefined;
  while (cursor.i < cursor.lines.length) {
    const lineNo = cursor.i + 1;
    const line = cursor.lines[cursor.i];
    if (isBlank(line) || isComment(line)) {
      cursor.i += 1;
      continue;
    }
    if (line.startsWith("\t")) {
      addIssue(sink, "line_malformed", "error", "tabs are not valid frontmatter indentation; use spaces.", { line: lineNo });
      cursor.i += 1;
      continue;
    }
    const indent = indentOf(line);
    if (minIndent === undefined) minIndent = indent;
    if (indent < minIndent) break;
    if (indent > minIndent) {
      addIssue(sink, "line_malformed", "error", `unexpected indentation (expected ${String(minIndent)} space(s) for this mapping level).`, { line: lineNo });
      skipBlockFrom(cursor, indent);
      continue;
    }
    const match = KEY_LINE.exec(line.slice(indent));
    if (!match) {
      addIssue(sink, "line_malformed", "error", `line is not a "key: value" frontmatter entry.`, { line: lineNo });
      cursor.i += 1;
      continue;
    }
    const key = match[1];
    const rest = (match[2] ?? "").trimEnd();
    cursor.i += 1;
    entries.push(Object.freeze({ key, value: parseValue(rest, cursor, sink, indent, depth, lineNo), line: lineNo }));
  }
  return entries;
}

/** Consume an anomalous deeper-indented line plus its own block; returns lines consumed. */
function skipBlockFrom(cursor: LineCursor, _indent: number): number {
  const start = cursor.i;
  cursor.i = blockEnd(cursor, _indent - 1);
  return cursor.i - start;
}

function parseValue(rest: string, cursor: LineCursor, sink: Sink, parentIndent: number, depth: number, lineNo: number): RawValue {
  if (rest === "") {
    const end = blockEnd(cursor, parentIndent);
    const block = cursor.lines.slice(cursor.i, end);
    const nonBlank = block.filter((line) => !isBlank(line));
    if (nonBlank.length === 0) {
      cursor.i = end;
      return scalarValue("");
    }
    const first = nonBlank[0].slice(indentOf(nonBlank[0]));
    if (first === "-" || first.startsWith("- ")) {
      cursor.i = end;
      return parseDashList(nonBlank, sink, lineNo);
    }
    if (KEY_LINE.test(first)) {
      if (depth >= 1) {
        addIssue(sink, "nested_value_unsupported", "warning", "frontmatter values nest at most one level deep in the SKILL.md subset; this deeper mapping was skipped.", { line: lineNo });
        cursor.i = end;
        return scalarValue("");
      }
      const nested = parseMapping(cursor, sink, depth + 1);
      return mappingValue(nested);
    }
    cursor.i = end;
    return scalarValue(foldLines(block));
  }
  const opener = rest[0];
  if (opener === '"' || opener === "'") {
    const scanned = scanQuoted(rest, 0, sink, lineNo);
    if (!scanned) return scalarValue(rest.slice(1), true);
    if (!remainderClean(rest, scanned.end)) {
      addIssue(sink, "line_malformed", "error", "content other than a comment follows the closing quote of a scalar.", { line: lineNo });
    }
    return scalarValue(scanned.value, true);
  }
  if (opener === "[") {
    return parseInlineList(rest, sink, lineNo) ?? listValue([]);
  }
  if (opener === "|" || opener === ">") {
    const header = BLOCK_HEADER.exec(rest);
    if (!header) {
      addIssue(sink, "block_scalar_bad_header", "warning", `block scalar header "${rest}" is outside the SKILL.md subset (only | and > with - or + chomping); treating it as a plain scalar.`, { line: lineNo });
      return scalarValue(rest);
    }
    return scalarValue(parseBlockScalar(opener as "|" | ">", header[1] as "+" | "-" | undefined, cursor, parentIndent).text);
  }
  if (opener === "#") {
    return scalarValue("");
  }
  return scalarValue(stripPlainComment(rest).trimEnd());
}

function parseDashList(lines: readonly string[], sink: Sink, lineNo: number): RawValue {
  const items: RawScalar[] = [];
  for (const raw of lines) {
    const indent = indentOf(raw);
    const text = raw.slice(indent);
    if (text === "-" || text.startsWith("- ")) {
      const itemText = text === "-" ? "" : text.slice(2).trimEnd();
      if (itemText.startsWith('"') || itemText.startsWith("'")) {
        const scanned = scanQuoted(itemText, 0, sink, lineNo);
        if (!scanned) continue;
        items.push(Object.freeze({ text: scanned.value, quoted: true }));
      } else if (itemText === "") {
        addIssue(sink, "list_item_malformed", "warning", "dash list item is empty; the item was skipped.", { line: lineNo });
      } else {
        items.push(Object.freeze({ text: stripPlainComment(itemText), quoted: false }));
      }
      continue;
    }
    // A deeper continuation folds into the previous item (YAML plain-scalar rule inside block lists).
    const previous = items[items.length - 1];
    if (previous && !previous.quoted) {
      items[items.length - 1] = Object.freeze({ text: `${previous.text} ${text.trim()}`, quoted: false });
    } else if (previous && previous.quoted) {
      addIssue(sink, "list_item_malformed", "warning", "continuation after a quoted list item is outside the SKILL.md subset; the continuation line was skipped.", { line: lineNo });
    }
  }
  return listValue(items);
}

/** normalizeKey: kebab-case, snake_case, and camelCase spellings land on the one camelCase field. Keys stay case-sensitive (YAML rule): `Name:` is an unknown key, not a typo we launder into a skill name. */
const KNOWN_KEYS: Readonly<Record<string, string>> = Object.freeze({
  name: "name",
  description: "description",
  version: "version",
  author: "author",
  env: "env",
  "allowed-tools": "allowedTools",
  allowed_tools: "allowedTools",
  allowedTools: "allowedTools",
  "load-context": "loadContext",
  load_context: "loadContext",
  loadContext: "loadContext",
  "disable-model-invocation": "disableModelInvocation",
  disable_model_invocation: "disableModelInvocation",
  disableModelInvocation: "disableModelInvocation",
});

function normalizeKey(key: string): string | undefined {
  return KNOWN_KEYS[key];
}

function requireString(
  value: RawValue,
  field: "name" | "description" | "version" | "author",
  sink: Sink,
  line: number,
): string | undefined {
  if (value.kind !== "scalar") {
    addIssue(sink, `${field}_not_string` as PrimeSkillFileIssueCode, field === "name" || field === "description" ? "error" : "warning", `${field} must be a single string, not a ${value.kind}.`, { field, line });
    return undefined;
  }
  return value.scalar.text;
}

export type ParseSkillMdOptions = Readonly<{
  /**
   * The directory the SKILL.md lives in (its basename), used for the
   * upstream name/parity rules: a missing name falls back to it, and a
   * name that disagrees with it is a warning, not a rejection.
   */
  parentDirName?: string;
}>;

/**
 * Parse one SKILL.md. Never throws; every rejection reason is a named
 * issue. Issues with severity "error" mean the registry must refuse the
 * skill (name/description poison, structural ambiguity); warnings keep
 * the skill with the offending field dropped or trimmed, mirroring
 * upstream's tolerate-and-diagnose stance for the exact cases upstream
 * tolerated.
 */
export function parseSkillMd(content: string, options: ParseSkillMdOptions = {}): ParsedSkillMd {
  const sink: Sink = { issues: [] };
  if (content.length > MAX_SKILL_MD_CHARS) {
    addIssue(sink, "skill_md_too_large", "error", `SKILL.md is ${String(content.length)} chars, over the ${String(MAX_SKILL_MD_CHARS)}-char parse bound; refuse oversized skill sources instead of trusting a partial frontmatter.`);
    return Object.freeze({ frontmatter: undefined, body: "", issues: Object.freeze(sink.issues) });
  }
  const normalized = normalizeNewlines(content);
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0].trimEnd() !== "---") {
    // No frontmatter at all: upstream ends here with an empty record and the
    // description gate then drops the skill. Keep both facts named.
    if (options.parentDirName === undefined) {
      addIssue(sink, "name_missing", "error", "name is required: no frontmatter exists and there is no parent directory name to fall back to.", { field: "name" });
    } else {
      addIssue(sink, "name_missing", "warning", `name is missing; falling back to the parent directory name "${options.parentDirName}" (upstream convention).`, { field: "name" });
    }
    addIssue(sink, "description_missing", "error", "description is required", { field: "description" });
    return Object.freeze({ frontmatter: {}, body: normalized, issues: Object.freeze(sink.issues) });
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    addIssue(sink, "frontmatter_unterminated", "error", "frontmatter opens with --- but no closing --- line exists; the whole file is treated as body, no frontmatter fields are trusted.");
    return Object.freeze({ frontmatter: undefined, body: normalized, issues: Object.freeze(sink.issues) });
  }
  const frontmatterLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join("\n").trim();

  const firstMeaningful = frontmatterLines.find((line) => !isBlank(line) && !isComment(line));
  if (firstMeaningful !== undefined) {
    const trimmed = firstMeaningful.trimStart();
    const looksLikeEntry = KEY_LINE.test(trimmed);
    if (!looksLikeEntry && (trimmed === "-" || trimmed.startsWith("- ") || !trimmed.includes(":"))) {
      addIssue(sink, "frontmatter_not_mapping", "error", "frontmatter must be a flat key: value mapping, not a list or bare scalar.");
      return Object.freeze({ frontmatter: undefined, body, issues: Object.freeze(sink.issues) });
    }
  }

  const cursor: LineCursor = { lines: frontmatterLines, i: 0 };
  const entries = parseMapping(cursor, sink, 0);

  // Duplicate normalized keys are ambiguous source: keep the first
  // (fail-closed reading) and name every repeat, mirroring the YAML
  // loader's duplicate-key rejection as a port-side error.
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const field = normalizeKey(entry.key);
    if (field === undefined) continue;
    const prior = seen.get(`${field}`);
    if (prior !== undefined) {
      addIssue(sink, "duplicate_key", "error", `key "${entry.key}" duplicates "${entries[prior].key}" after key normalization; the first occurrence wins.`, { field: entry.key, line: entry.line });
      continue;
    }
    seen.set(field, entries.indexOf(entry));
  }

  const frontmatter: Record<string, unknown> = {};
  let nameTouched = false;
  let descriptionTouched = false;
  for (const entry of entries) {
    const field = normalizeKey(entry.key);
    if (field === undefined) {
      addIssue(sink, "unsupported_key", "warning", `frontmatter key "${entry.key}" is not one the prime skills system honors; it was ignored (upstream tolerated unknown keys).`, { field: entry.key, line: entry.line });
      continue;
    }
    if (sink.issues.some((issue) => issue.code === "duplicate_key" && issue.field === entry.key)) continue;
    switch (field) {
      case "name": {
        nameTouched = true;
        const text = requireString(entry.value, "name", sink, entry.line);
        if (text === undefined) break;
        if (text === "") {
          nameTouched = false;
          break;
        }
        if (text.length > MAX_SKILL_NAME_CHARS) {
          addIssue(sink, "name_length_exceeded", "error", `name exceeds ${String(MAX_SKILL_NAME_CHARS)} characters (${String(text.length)})`, { field, line: entry.line });
          break;
        }
        if (!/^[a-z0-9-]+$/.test(text)) {
          addIssue(sink, "name_invalid_characters", "error", "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)", { field, line: entry.line });
          break;
        }
        if (text.startsWith("-") || text.endsWith("-")) {
          addIssue(sink, "name_leading_trailing_hyphen", "error", "name must not start or end with a hyphen", { field, line: entry.line });
          break;
        }
        if (text.includes("--")) {
          addIssue(sink, "name_consecutive_hyphens", "error", "name must not contain consecutive hyphens", { field, line: entry.line });
          break;
        }
        if (options.parentDirName !== undefined && text !== options.parentDirName) {
          addIssue(sink, "name_parent_dir_mismatch", "warning", `name "${text}" does not match parent directory "${options.parentDirName}"`, { field, line: entry.line });
        }
        frontmatter.name = text;
        break;
      }
      case "description": {
        descriptionTouched = true;
        const text = requireString(entry.value, "description", sink, entry.line);
        if (text === undefined) break;
        if (text.trim() === "") {
          descriptionTouched = false;
          break;
        }
        if (text.length > MAX_SKILL_DESCRIPTION_CHARS) {
          addIssue(sink, "description_length_exceeded", "error", `description exceeds ${String(MAX_SKILL_DESCRIPTION_CHARS)} characters (${String(text.length)})`, { field, line: entry.line });
          break;
        }
        frontmatter.description = text;
        break;
      }
      case "version": {
        const text = requireString(entry.value, "version", sink, entry.line);
        if (text === undefined) break;
        if (text.length > MAX_SKILL_VERSION_CHARS) {
          addIssue(sink, "version_length_exceeded", "warning", `version exceeds ${String(MAX_SKILL_VERSION_CHARS)} chars; the field was dropped.`, { field, line: entry.line });
          break;
        }
        if (text !== "") frontmatter.version = text;
        break;
      }
      case "author": {
        const text = requireString(entry.value, "author", sink, entry.line);
        if (text === undefined) break;
        if (text.length > MAX_SKILL_AUTHOR_CHARS) {
          addIssue(sink, "author_length_exceeded", "warning", `author exceeds ${String(MAX_SKILL_AUTHOR_CHARS)} chars; the field was dropped.`, { field, line: entry.line });
          break;
        }
        if (text !== "") frontmatter.author = text;
        break;
      }
      case "env": {
        if (entry.value.kind !== "mapping") {
          addIssue(sink, "env_not_mapping", "warning", "env must be a flat mapping of NAME: value entries; the field was dropped.", { field, line: entry.line });
          break;
        }
        if (entry.value.entries.length > MAX_SKILL_ENV_ENTRIES) {
          addIssue(sink, "env_too_many_entries", "warning", `env declares ${String(entry.value.entries.length)} entries; keeping the first ${String(MAX_SKILL_ENV_ENTRIES)}.`, { field, line: entry.line });
        }
        const env: Record<string, string> = {};
        for (const sub of entry.value.entries.slice(0, MAX_SKILL_ENV_ENTRIES)) {
          if (sub.key.length > MAX_SKILL_ENV_KEY_CHARS) {
            addIssue(sink, "env_key_length_exceeded", "warning", `env key "${sub.key.slice(0, 32)}…" exceeds ${String(MAX_SKILL_ENV_KEY_CHARS)} chars; the entry was dropped.`, { field, line: sub.line });
            continue;
          }
          if (!ENV_KEY_PATTERN.test(sub.key)) {
            addIssue(sink, "env_key_invalid", "warning", `env key ${JSON.stringify(sub.key)} is not a shell-style variable name; the entry was dropped.`, { field, line: sub.line });
            continue;
          }
          if (sub.value.kind !== "scalar") {
            addIssue(sink, "env_value_not_string", "warning", `env.${sub.key} must be a single string; the entry was dropped.`, { field, line: sub.line });
            continue;
          }
          if (sub.value.scalar.text.length > MAX_SKILL_ENV_VALUE_CHARS) {
            addIssue(sink, "env_value_length_exceeded", "warning", `env.${sub.key} exceeds ${String(MAX_SKILL_ENV_VALUE_CHARS)} chars; the entry was dropped.`, { field, line: sub.line });
            continue;
          }
          env[sub.key] = sub.value.scalar.text;
        }
        frontmatter.env = Object.freeze(env);
        break;
      }
      case "allowedTools":
      case "loadContext": {
        if (entry.value.kind !== "list") {
          addIssue(sink, field === "allowedTools" ? "allowed_tools_not_list" : "load_context_not_list", "warning", `${entry.key} must be a list of strings; the field was dropped.`, { field, line: entry.line });
          break;
        }
        if (entry.value.items.length > MAX_SKILL_LIST_ITEMS) {
          addIssue(sink, "list_too_many_items", "warning", `${entry.key} declares ${String(entry.value.items.length)} items; keeping the first ${String(MAX_SKILL_LIST_ITEMS)}.`, { field, line: entry.line });
        }
        const items: string[] = [];
        for (const item of entry.value.items.slice(0, MAX_SKILL_LIST_ITEMS)) {
          if (item.text.length > MAX_SKILL_LIST_ITEM_CHARS) {
            addIssue(sink, "list_item_length_exceeded", "warning", `${entry.key} item exceeds ${String(MAX_SKILL_LIST_ITEM_CHARS)} chars (${String(item.text.length)}); the item was skipped.`, { field, line: entry.line });
            continue;
          }
          items.push(item.text);
        }
        frontmatter[field] = Object.freeze(items);
        break;
      }
      case "disableModelInvocation": {
        const value = entry.value;
        if (value.kind === "scalar" && !value.scalar.quoted && (BOOLEAN_TRUE.has(value.scalar.text) || BOOLEAN_FALSE.has(value.scalar.text))) {
          frontmatter.disableModelInvocation = BOOLEAN_TRUE.has(value.scalar.text);
          break;
        }
        if (value.kind === "scalar" && !value.scalar.quoted && value.scalar.text === "") {
          break;
        }
        addIssue(sink, "disable_model_invocation_not_boolean", "warning", "disable-model-invocation must be a YAML boolean (true/false); the field was dropped.", { field, line: entry.line });
        break;
      }
    }
  }

  if (!nameTouched || frontmatter.name === undefined) {
    if (!nameTouched) {
      if (options.parentDirName === undefined) {
        addIssue(sink, "name_missing", "error", "name is required: the frontmatter sets none and there is no parent directory name to fall back to.", { field: "name" });
      } else {
        addIssue(sink, "name_missing", "warning", `name is missing; falling back to the parent directory name "${options.parentDirName}" (upstream convention).`, { field: "name" });
      }
    }
  }
  if (!descriptionTouched || frontmatter.description === undefined) {
    if (!descriptionTouched) {
      addIssue(sink, "description_missing", "error", "description is required", { field: "description" });
    } else if (frontmatter.description === undefined && !sink.issues.some((issue) => issue.field === "description" && issue.severity === "error")) {
      addIssue(sink, "description_missing", "error", "description is required", { field: "description" });
    }
  }

  return Object.freeze({
    frontmatter: Object.freeze(frontmatter) as PrimeSkillFrontmatter,
    body,
    issues: Object.freeze(sink.issues),
  });
}
