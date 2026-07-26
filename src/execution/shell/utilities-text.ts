import type { CommandContext, CommandHandler } from "./command";
import { ShellCommandError, unsupportedOption, usageError } from "./errors";
import { joinPath } from "./filesystem";
import { parseOptions } from "./options";
import { assertBoundedSubject, compileRegex } from "./regex";
import { decodeText, encodeText } from "./streams";
import {
  emit,
  emitLine,
  inputLines,
  inputText,
  joinLines,
  requirePositiveInteger,
  resolveInputs,
  warn,
  type NamedInput,
} from "./utility-support";

export const TEXT_UTILITIES: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ["head", head],
  ["tail", tail],
  ["wc", wordCount],
  ["grep", grep],
  ["sed", sed],
  ["sort", sort],
  ["uniq", uniq],
  ["cut", cut],
  ["tr", translate],
  ["seq", seq],
  ["date", dateCommand],
  ["env", envCommand],
  ["xargs", xargs],
  ["sleep", sleep],
]);

/** `head -5` and `tail -5` are the historical spellings every script still uses. */
function normalizeLegacyCount(argv: readonly string[]): readonly string[] {
  return argv.map((argument, index) => (index > 0 && /^-[0-9]+$/u.test(argument) ? `-n${argument.slice(1)}` : argument));
}

async function head(context: CommandContext): Promise<number> {
  const parsed = parseOptions("head", normalizeLegacyCount(context.argv), { flags: "qv", values: "nc" });
  const inputs = resolveInputs(context, parsed.operands);
  const showNames = inputs.length > 1 ? !parsed.flags.has("q") : parsed.flags.has("v");
  const bytes = parsed.values.get("c");
  const count = bytes === undefined ? requirePositiveInteger("head", parsed.values.get("n") ?? "10", "line count") : 0;
  inputs.forEach((input, index) => {
    if (showNames) emitLine(context, `${index > 0 ? "\n" : ""}==> ${input.name} <==`);
    if (bytes !== undefined) {
      context.stdout.write(input.bytes.subarray(0, requirePositiveInteger("head", bytes, "byte count")));
      return;
    }
    emit(context, joinLines(inputLines(input).slice(0, count)));
  });
  return 0;
}

async function tail(context: CommandContext): Promise<number> {
  const parsed = parseOptions("tail", normalizeLegacyCount(context.argv), { flags: "qv", values: "nc" });
  const inputs = resolveInputs(context, parsed.operands);
  const showNames = inputs.length > 1 ? !parsed.flags.has("q") : parsed.flags.has("v");
  const bytes = parsed.values.get("c");
  const raw = parsed.values.get("n") ?? "10";
  const fromStart = raw.startsWith("+");
  const count = requirePositiveInteger("tail", raw.replace(/^[+-]/u, ""), "line count");
  inputs.forEach((input, index) => {
    if (showNames) emitLine(context, `${index > 0 ? "\n" : ""}==> ${input.name} <==`);
    if (bytes !== undefined) {
      const size = requirePositiveInteger("tail", bytes.replace(/^[+-]/u, ""), "byte count");
      context.stdout.write(input.bytes.subarray(Math.max(0, input.bytes.byteLength - size)));
      return;
    }
    const lines = inputLines(input);
    emit(context, joinLines(fromStart ? lines.slice(Math.max(0, count - 1)) : lines.slice(Math.max(0, lines.length - count))));
  });
  return 0;
}

async function wordCount(context: CommandContext): Promise<number> {
  const parsed = parseOptions("wc", context.argv, { flags: "lwcm" });
  const inputs = resolveInputs(context, parsed.operands);
  const selected = ["l", "w", "c", "m"].filter((flag) => parsed.flags.has(flag));
  const columns = selected.length > 0 ? selected : ["l", "w", "c"];
  const totals = new Map<string, number>(columns.map((column) => [column, 0]));
  for (const input of inputs) {
    context.shell.charge();
    const text = inputText(input);
    const counts: Readonly<Record<string, number>> = Object.freeze({
      l: (text.match(/\n/gu) ?? []).length,
      w: text.split(/\s+/u).filter((word) => word.length > 0).length,
      c: input.bytes.byteLength,
      m: [...text].length,
    });
    for (const column of columns) totals.set(column, (totals.get(column) ?? 0) + counts[column]);
    // Unpadded, space-separated fields. A padded count is the single most
    // common reason `n=$(wc -l < f)` then fails an arithmetic comparison.
    const rendered = columns.map((column) => String(counts[column])).join(" ");
    emitLine(context, parsed.operands.length > 0 ? `${rendered} ${input.name}` : rendered);
  }
  if (inputs.length > 1) {
    emitLine(context, `${columns.map((column) => String(totals.get(column) ?? 0)).join(" ")} total`);
  }
  return 0;
}

async function grep(context: CommandContext): Promise<number> {
  const parsed = parseOptions("grep", context.argv, {
    flags: "ivnclqEFwxhHrRs",
    values: "e",
    stopAtFirstOperand: false,
  });
  const operands = [...parsed.operands];
  const explicit = parsed.values.get("e");
  const pattern = explicit ?? operands.shift();
  if (pattern === undefined) throw usageError("grep", "usage: grep [options] pattern [file ...]");
  const expression = compileRegex(pattern, {
    extended: parsed.flags.has("E"),
    fixed: parsed.flags.has("F"),
    ignoreCase: parsed.flags.has("i"),
    wholeWord: parsed.flags.has("w"),
    wholeLine: parsed.flags.has("x"),
  });
  const recursive = parsed.flags.has("r") || parsed.flags.has("R");
  const inputs = recursive ? collectRecursiveInputs(context, operands) : resolveInputs(context, operands);
  const showNames = parsed.flags.has("H") || (!parsed.flags.has("h") && inputs.length > 1);
  let matched = false;
  let count = 0;
  for (const input of inputs) {
    let fileMatches = 0;
    inputLines(input).forEach((line, index) => {
      context.shell.charge();
      assertBoundedSubject(line);
      const hit = expression.test(line) !== parsed.flags.has("v");
      if (!hit) return;
      matched = true;
      fileMatches += 1;
      count += 1;
      if (parsed.flags.has("q") || parsed.flags.has("c") || parsed.flags.has("l")) return;
      const prefix = `${showNames ? `${input.name}:` : ""}${parsed.flags.has("n") ? `${index + 1}:` : ""}`;
      emitLine(context, `${prefix}${line}`);
    });
    if (parsed.flags.has("l") && fileMatches > 0) emitLine(context, input.name);
    if (parsed.flags.has("c") && !parsed.flags.has("l")) {
      emitLine(context, showNames ? `${input.name}:${fileMatches}` : String(fileMatches));
    }
  }
  void count;
  return matched ? 0 : 1;
}

function collectRecursiveInputs(context: CommandContext, operands: readonly string[]): readonly NamedInput[] {
  const fs = context.shell.fs;
  const inputs: NamedInput[] = [];
  const visit = (path: string, display: string): void => {
    context.shell.charge();
    if (fs.isDirectory(path)) {
      for (const name of fs.list(path)) visit(joinPath(path, name), `${display}/${name}`);
      return;
    }
    inputs.push(Object.freeze({ name: display, bytes: fs.readFile(path) }));
  };
  for (const operand of operands.length > 0 ? operands : ["."]) {
    const path = fs.resolve(operand);
    if (!fs.exists(path)) {
      warn(context, "grep", `${operand}: No such file or directory`);
      continue;
    }
    visit(path, operand);
  }
  return Object.freeze(inputs);
}

type SedAddress =
  | Readonly<{ kind: "line"; line: number }>
  | Readonly<{ kind: "last" }>
  | Readonly<{ kind: "regex"; expression: RegExp }>;

type SedCommand = Readonly<{
  start?: SedAddress;
  end?: SedAddress;
  action: "s" | "p" | "d" | "q" | "=";
  expression?: RegExp;
  replacement?: string;
  print?: boolean;
}>;

/**
 * `sed` with the substitute, print, delete, quit, and line-number commands.
 * Anything else — hold space, branching, `a`/`i`/`c`, `y` — is rejected by
 * name, because a stream editor that quietly skipped a command would corrupt
 * a file while reporting success.
 */
async function sed(context: CommandContext): Promise<number> {
  const parsed = parseOptions("sed", context.argv, { flags: "nEr", values: "e" });
  const operands = [...parsed.operands];
  const scriptSource = parsed.values.get("e") ?? operands.shift();
  if (scriptSource === undefined) throw usageError("sed", "usage: sed [-n] [-E] script [file ...]");
  const extended = parsed.flags.has("E") || parsed.flags.has("r");
  const commands = scriptSource
    .split(/\n|;(?![^/]*\/)/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => parseSedCommand(line, extended));
  const inputs = resolveInputs(context, operands);
  const quiet = parsed.flags.has("n");
  for (const input of inputs) {
    const lines = inputLines(input);
    const active = new Set<SedCommand>();
    const output: string[] = [];
    for (const [index, original] of lines.entries()) {
      context.shell.charge();
      assertBoundedSubject(original);
      let line: string | undefined = original;
      let printed = false;
      let quit = false;
      for (const command of commands) {
        if (line === undefined) break;
        if (!sedSelects(command, line, index + 1, lines.length, active)) continue;
        switch (command.action) {
          case "s": {
            line = line.replace(command.expression!, command.replacement!);
            if (command.print === true) {
              output.push(line);
              printed = true;
            }
            break;
          }
          case "p":
            output.push(line);
            printed = true;
            break;
          case "d":
            line = undefined;
            break;
          case "=":
            output.push(String(index + 1));
            break;
          case "q":
            quit = true;
            break;
        }
      }
      if (line !== undefined && !quiet && !printed) output.push(line);
      if (line !== undefined && !quiet && printed && !commands.some((command) => command.action === "p")) {
        // `s///p` under `-n` prints once; without `-n` the pattern space is
        // printed again at end of cycle, matching POSIX.
        output.push(line);
      }
      if (quit) break;
    }
    emit(context, joinLines(output));
  }
  return 0;
}

function sedSelects(
  command: SedCommand,
  line: string,
  lineNumber: number,
  total: number,
  active: Set<SedCommand>,
): boolean {
  if (!command.start) return true;
  const matchesStart = matchesSedAddress(command.start, line, lineNumber, total);
  if (!command.end) return matchesStart;
  if (active.has(command)) {
    if (matchesSedAddress(command.end, line, lineNumber, total)) active.delete(command);
    return true;
  }
  if (!matchesStart) return false;
  active.add(command);
  return true;
}

function matchesSedAddress(address: SedAddress, line: string, lineNumber: number, total: number): boolean {
  switch (address.kind) {
    case "line":
      return address.line === lineNumber;
    case "last":
      return lineNumber === total;
    case "regex":
      return address.expression.test(line);
  }
}

function parseSedCommand(source: string, extended: boolean): SedCommand {
  let rest = source;
  let start: SedAddress | undefined;
  let end: SedAddress | undefined;
  const readAddress = (): SedAddress | undefined => {
    const numeric = /^([0-9]+)/u.exec(rest);
    if (numeric) {
      rest = rest.slice(numeric[0].length);
      return Object.freeze({ kind: "line", line: Number.parseInt(numeric[1], 10) });
    }
    if (rest.startsWith("$")) {
      rest = rest.slice(1);
      return Object.freeze({ kind: "last" });
    }
    if (rest.startsWith("/")) {
      const close = findUnescaped(rest, "/", 1);
      if (close === -1) throw usageError("sed", `unterminated address: ${source}`);
      const expression = compileRegex(rest.slice(1, close), { extended });
      rest = rest.slice(close + 1);
      return Object.freeze({ kind: "regex", expression });
    }
    return undefined;
  };
  start = readAddress();
  if (start && rest.startsWith(",")) {
    rest = rest.slice(1);
    end = readAddress();
    if (!end) throw usageError("sed", `expected a second address: ${source}`);
  }
  rest = rest.trim();
  const action = rest[0];
  if (action === "s") {
    const delimiter = rest[1];
    if (delimiter === undefined) throw usageError("sed", `incomplete s command: ${source}`);
    const middle = findUnescaped(rest, delimiter, 2);
    if (middle === -1) throw usageError("sed", `unterminated s command: ${source}`);
    const close = findUnescaped(rest, delimiter, middle + 1);
    if (close === -1) throw usageError("sed", `unterminated s command: ${source}`);
    const flags = rest.slice(close + 1);
    for (const flag of flags) if (!"gpiI".includes(flag)) throw unsupportedOption("sed", `s///${flag}`);
    return Object.freeze({
      start,
      end,
      action: "s",
      expression: compileRegex(rest.slice(2, middle), {
        extended,
        ignoreCase: flags.includes("i") || flags.includes("I"),
        global: flags.includes("g"),
      }),
      replacement: translateReplacement(rest.slice(middle + 1, close)),
      print: flags.includes("p"),
    });
  }
  if (action === "p" || action === "d" || action === "q" || action === "=") {
    return Object.freeze({ start, end, action });
  }
  throw usageError(
    "sed",
    `unsupported command: ${source} (airship-sh implements s, p, d, q, and = with line, $, and /regex/ addresses)`,
  );
}

function findUnescaped(text: string, character: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === character) return index;
  }
  return -1;
}

/** `&` and `\1` in a sed replacement mean what `$&` and `$1` mean to `RegExp`. */
function translateReplacement(source: string): string {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      index += 1;
      if (next === undefined) break;
      if (/^[0-9]$/u.test(next)) {
        output += `$${next}`;
        continue;
      }
      if (next === "n") {
        output += "\n";
        continue;
      }
      if (next === "t") {
        output += "\t";
        continue;
      }
      output += next === "&" ? "&" : next;
      continue;
    }
    if (char === "&") {
      output += "$&";
      continue;
    }
    output += char === "$" ? "$$" : char;
  }
  return output;
}

async function sort(context: CommandContext): Promise<number> {
  const parsed = parseOptions("sort", context.argv, { flags: "rnufb", values: "tk" });
  const inputs = resolveInputs(context, parsed.operands);
  const lines = inputs.flatMap((input) => inputLines(input));
  const separator = parsed.values.get("t");
  const keySpec = parsed.values.get("k");
  const keyIndex = keySpec === undefined ? undefined : requirePositiveInteger("sort", keySpec.split(",")[0], "key");
  const keyOf = (line: string): string => {
    if (keyIndex === undefined) return line;
    const fields = separator === undefined ? line.trim().split(/\s+/u) : line.split(separator);
    return fields[keyIndex - 1] ?? "";
  };
  context.shell.charge(lines.length);
  const prepared = lines.map((line) => {
    let key = keyOf(line);
    if (parsed.flags.has("b")) key = key.replace(/^\s+/u, "");
    if (parsed.flags.has("f")) key = key.toLowerCase();
    return { line, key };
  });
  prepared.sort((left, right) => {
    if (parsed.flags.has("n")) {
      const leftValue = Number.parseFloat(left.key);
      const rightValue = Number.parseFloat(right.key);
      const leftNumber = Number.isNaN(leftValue) ? 0 : leftValue;
      const rightNumber = Number.isNaN(rightValue) ? 0 : rightValue;
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      return 0;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  let result = prepared.map(({ line }) => line);
  if (parsed.flags.has("r")) result = result.reverse();
  if (parsed.flags.has("u")) {
    const seen = new Set<string>();
    result = result.filter((line) => {
      const key = parsed.flags.has("f") ? keyOf(line).toLowerCase() : keyOf(line);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  emit(context, joinLines(result));
  return 0;
}

async function uniq(context: CommandContext): Promise<number> {
  const parsed = parseOptions("uniq", context.argv, { flags: "cdui" });
  const inputs = resolveInputs(context, parsed.operands.slice(0, 1));
  const lines = inputs.flatMap((input) => inputLines(input));
  const groups: { line: string; count: number }[] = [];
  for (const line of lines) {
    context.shell.charge();
    const previous = groups[groups.length - 1];
    const same = previous !== undefined
      && (parsed.flags.has("i") ? previous.line.toLowerCase() === line.toLowerCase() : previous.line === line);
    if (same) previous.count += 1;
    else groups.push({ line, count: 1 });
  }
  const selected = groups.filter((group) => {
    if (parsed.flags.has("d")) return group.count > 1;
    if (parsed.flags.has("u")) return group.count === 1;
    return true;
  });
  emit(
    context,
    joinLines(selected.map((group) => (parsed.flags.has("c") ? `${String(group.count).padStart(7)} ${group.line}` : group.line))),
  );
  return 0;
}

async function cut(context: CommandContext): Promise<number> {
  const parsed = parseOptions("cut", context.argv, { flags: "s", values: "dfc" });
  const fieldSpec = parsed.values.get("f");
  const charSpec = parsed.values.get("c");
  if ((fieldSpec === undefined) === (charSpec === undefined)) {
    throw usageError("cut", "usage: cut -f list [-d delim] [-s] | cut -c list");
  }
  const delimiter = parsed.values.get("d") ?? "\t";
  const ranges = parseRanges("cut", (fieldSpec ?? charSpec)!);
  const inputs = resolveInputs(context, parsed.operands);
  const output: string[] = [];
  for (const input of inputs) {
    for (const line of inputLines(input)) {
      context.shell.charge();
      if (charSpec !== undefined) {
        const characters = [...line];
        output.push(ranges.flatMap(([from, to]) => characters.slice(from - 1, to)).join(""));
        continue;
      }
      if (!line.includes(delimiter)) {
        if (!parsed.flags.has("s")) output.push(line);
        continue;
      }
      const fields = line.split(delimiter);
      output.push(ranges.flatMap(([from, to]) => fields.slice(from - 1, to)).join(delimiter));
    }
  }
  emit(context, joinLines(output));
  return 0;
}

function parseRanges(command: string, spec: string): readonly (readonly [number, number])[] {
  return spec.split(",").map((part) => {
    const match = /^([0-9]*)(-?)([0-9]*)$/u.exec(part.trim());
    if (!match || (match[1] === "" && match[3] === "")) throw usageError(command, `invalid list: ${spec}`);
    const from = match[1] === "" ? 1 : Number.parseInt(match[1], 10);
    if (match[2] === "") return Object.freeze([from, from] as const);
    const to = match[3] === "" ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[3], 10);
    return Object.freeze([from, to] as const);
  });
}

async function translate(context: CommandContext): Promise<number> {
  const parsed = parseOptions("tr", context.argv, { flags: "dscC" });
  const operands = parsed.operands;
  const deleting = parsed.flags.has("d");
  if (operands.length === 0 || operands.length > 2 || (deleting && operands.length > 2)) {
    throw usageError("tr", "usage: tr [-dsc] set1 [set2]");
  }
  const complement = parsed.flags.has("c") || parsed.flags.has("C");
  const set1 = expandSet("tr", operands[0]);
  const set2 = operands[1] === undefined ? [] : expandSet("tr", operands[1]);
  const text = decodeText(context.stdin.readAll());
  const inSet1 = (char: string): boolean => (complement ? !set1.includes(char) : set1.includes(char));
  let output = "";
  let previous: string | undefined;
  for (const char of text) {
    context.shell.charge();
    if (deleting && inSet1(char)) continue;
    let mapped = char;
    if (!deleting && inSet1(char) && set2.length > 0) {
      const index = complement ? set2.length - 1 : set1.indexOf(char);
      mapped = set2[Math.min(index, set2.length - 1)] ?? char;
    }
    if (parsed.flags.has("s") && mapped === previous && (deleting ? inSet1(char) : set2.includes(mapped))) continue;
    previous = mapped;
    output += mapped;
  }
  context.stdout.write(encodeText(output));
  return 0;
}

const TR_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  alpha: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  alnum: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  space: " \t\n\r\f\v",
  blank: " \t",
  punct: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
});

function expandSet(command: string, spec: string): readonly string[] {
  const characters: string[] = [];
  let index = 0;
  while (index < spec.length) {
    if (spec.startsWith("[:", index)) {
      const close = spec.indexOf(":]", index + 2);
      if (close === -1) throw usageError(command, `unterminated character class: ${spec}`);
      const name = spec.slice(index + 2, close);
      const expansion = TR_CLASSES[name];
      if (expansion === undefined) throw usageError(command, `unsupported character class: [:${name}:]`);
      characters.push(...expansion);
      index = close + 2;
      continue;
    }
    if (spec[index] === "\\") {
      const next = spec[index + 1] ?? "";
      characters.push(next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next);
      index += 2;
      continue;
    }
    if (spec[index + 1] === "-" && spec[index + 2] !== undefined) {
      const from = spec.charCodeAt(index);
      const to = spec.charCodeAt(index + 2);
      if (to < from) throw usageError(command, `invalid range: ${spec}`);
      for (let code = from; code <= to; code += 1) characters.push(String.fromCharCode(code));
      index += 3;
      continue;
    }
    characters.push(spec[index]);
    index += 1;
  }
  return Object.freeze(characters);
}

async function seq(context: CommandContext): Promise<number> {
  const parsed = parseOptions("seq", context.argv, { flags: "w", values: "s" });
  const numbers = parsed.operands.map((operand) => {
    const value = Number(operand);
    if (!Number.isFinite(value)) throw usageError("seq", `invalid number: ${operand}`);
    return value;
  });
  if (numbers.length === 0 || numbers.length > 3) throw usageError("seq", "usage: seq [-w] [-s sep] [first [incr]] last");
  const first = numbers.length === 1 ? 1 : numbers[0];
  const increment = numbers.length === 3 ? numbers[1] : 1;
  const last = numbers[numbers.length - 1];
  if (increment === 0) throw usageError("seq", "increment must not be zero");
  const values: string[] = [];
  for (let value = first; increment > 0 ? value <= last : value >= last; value += increment) {
    context.shell.charge();
    values.push(String(Number(value.toFixed(10))));
  }
  const width = parsed.flags.has("w") ? Math.max(0, ...values.map((value) => value.length)) : 0;
  const padded = values.map((value) => value.padStart(width, "0"));
  const separator = parsed.values.get("s");
  emit(context, separator === undefined ? joinLines(padded) : `${padded.join(separator)}\n`);
  return 0;
}

const DATE_DIRECTIVES = "YmdHMSsFTjZaAbBeynt%";

async function dateCommand(context: CommandContext): Promise<number> {
  const parsed = parseOptions("date", context.argv, { flags: "u", values: "d" });
  const source = parsed.values.get("d");
  const when = source === undefined ? context.shell.startedAt : new Date(source);
  if (Number.isNaN(when.getTime())) throw usageError("date", `invalid date: ${source}`);
  const format = parsed.operands.find((operand) => operand.startsWith("+"));
  const extra = parsed.operands.filter((operand) => !operand.startsWith("+"));
  if (extra.length > 0) throw usageError("date", `setting the clock is not possible in airship-sh: ${extra[0]}`);
  // The browser has no timezone database this engine is willing to vouch for,
  // so `date` always reports UTC and says so rather than implying local time.
  emitLine(context, format === undefined ? formatDate(when, "+%a %b %e %T UTC %Y") : formatDate(when, format));
  return 0;
}

function formatDate(when: Date, format: string): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return format.slice(1).replace(/%(.)/gu, (_whole, directive: string) => {
    if (!DATE_DIRECTIVES.includes(directive)) throw usageError("date", `unsupported directive: %${directive}`);
    switch (directive) {
      case "Y":
        return String(when.getUTCFullYear());
      case "y":
        return pad(when.getUTCFullYear() % 100);
      case "m":
        return pad(when.getUTCMonth() + 1);
      case "d":
        return pad(when.getUTCDate());
      case "e":
        return String(when.getUTCDate()).padStart(2, " ");
      case "H":
        return pad(when.getUTCHours());
      case "M":
        return pad(when.getUTCMinutes());
      case "S":
        return pad(when.getUTCSeconds());
      case "s":
        return String(Math.floor(when.getTime() / 1_000));
      case "F":
        return `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`;
      case "T":
        return `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`;
      case "j": {
        const start = Date.UTC(when.getUTCFullYear(), 0, 0);
        return pad(Math.floor((when.getTime() - start) / 86_400_000), 3);
      }
      case "Z":
        return "UTC";
      case "a":
        return days[when.getUTCDay()];
      case "A":
        return `${days[when.getUTCDay()]}day`;
      case "b":
        return months[when.getUTCMonth()];
      case "B":
        return months[when.getUTCMonth()];
      case "n":
        return "\n";
      case "t":
        return "\t";
      default:
        return "%";
    }
  });
}

async function envCommand(context: CommandContext): Promise<number> {
  const parsed = parseOptions("env", context.argv, { flags: "i", stopAtFirstOperand: false });
  const assignments: (readonly [string, string])[] = [];
  const rest: string[] = [];
  for (const operand of parsed.operands) {
    if (rest.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(operand)) {
      const index = operand.indexOf("=");
      assignments.push(Object.freeze([operand.slice(0, index), operand.slice(index + 1)] as const));
      continue;
    }
    rest.push(operand);
  }
  if (rest.length === 0) {
    const base = parsed.flags.has("i") ? [] : context.shell.environmentEntries();
    for (const [name, value] of [...base, ...assignments]) emitLine(context, `${name}=${value}`);
    return 0;
  }
  const restore: (() => void)[] = [];
  if (parsed.flags.has("i")) {
    // `-i` means the command sees only the assignments given here, so every
    // inherited export is withdrawn for the duration and then restored.
    for (const [name] of context.shell.environmentEntries()) {
      restore.push(() => context.shell.setExported(name, true));
      context.shell.setExported(name, false);
    }
  }
  for (const [name, value] of assignments) {
    const previous = context.shell.lookup(name);
    const wasExported = context.shell.isExported(name);
    restore.push(() => {
      if (previous === undefined) context.shell.unset(name);
      else context.shell.assign(name, previous, { exported: wasExported });
    });
    context.shell.assign(name, value, { exported: true });
  }
  try {
    return await context.shell.invoke(rest, {
      stdin: context.stdin,
      stdout: context.stdout,
      stderr: context.stderr,
    });
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

async function xargs(context: CommandContext): Promise<number> {
  const parsed = parseOptions("xargs", context.argv, { flags: "r0", values: "nI", stopAtFirstOperand: false });
  const command = parsed.operands.length > 0 ? parsed.operands : ["echo"];
  const raw = decodeText(context.stdin.readAll());
  const items = parsed.flags.has("0")
    ? raw.split("\0").filter((item) => item.length > 0)
    : raw.split(/\s+/u).filter((item) => item.length > 0);
  if (items.length === 0 && parsed.flags.has("r")) return 0;
  const replace = parsed.values.get("I");
  const batchSize = parsed.values.get("n") === undefined
    ? items.length
    : requirePositiveInteger("xargs", parsed.values.get("n")!, "argument count");
  let status = 0;
  if (replace !== undefined) {
    for (const item of items) {
      await context.shell.tick();
      status = await context.shell.invoke(
        command.map((word) => word.split(replace).join(item)),
        { stdin: context.stdin, stdout: context.stdout, stderr: context.stderr },
      );
      if (status !== 0) return status;
    }
    return status;
  }
  for (let index = 0; index < Math.max(items.length, 1); index += Math.max(batchSize, 1)) {
    await context.shell.tick();
    const batch = items.slice(index, index + Math.max(batchSize, 1));
    if (batch.length === 0 && items.length > 0) break;
    status = await context.shell.invoke([...command, ...batch], {
      stdin: context.stdin,
      stdout: context.stdout,
      stderr: context.stderr,
    });
    if (status !== 0) return status;
    if (batchSize >= items.length) break;
  }
  return status;
}

/**
 * `sleep` yields to the task queue in slices so the deadline and cancellation
 * are still observed while it waits. It never blocks the page.
 */
async function sleep(context: CommandContext): Promise<number> {
  const seconds = Number(context.argv[1]);
  if (!Number.isFinite(seconds) || seconds < 0) throw usageError("sleep", "usage: sleep seconds");
  const until = Date.now() + seconds * 1_000;
  while (Date.now() < until) {
    context.shell.charge();
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, until - Date.now()))));
  }
  return 0;
}

export const TEXT_UTILITY_INTERNALS = Object.freeze({ parseSedCommand, expandSet, formatDate });
export type { SedCommand };
export const TEXT_UTILITY_ERRORS = ShellCommandError;
