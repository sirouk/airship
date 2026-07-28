import {
  SHELL_OPTION_FLAGS,
  SHELL_OPTION_NAMES,
  type CommandContext,
  type CommandHandler,
  type ShellOptionName,
} from "./command";
import { AIRSHIP_SH_MAX_ALIASES } from "./contract";
import { ShellCommandError, unsupportedOption, usageError } from "./errors";
import { parseOptions } from "./options";
import { ExitSignal, LoopSignal, ReturnSignal } from "./signals";
import { decodeText, encodeText } from "./streams";
import { evaluateTest } from "./test-expression";

function write(context: CommandContext, text: string): void {
  context.stdout.write(encodeText(text));
}

function parseStatus(command: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/u.test(raw)) throw usageError(command, `numeric argument required: ${raw}`);
  return Number.parseInt(raw, 10) & 0xff;
}

/**
 * POSIX special builtins: they resolve before functions and their variable
 * assignments persist past the command.
 */
export const SPECIAL_BUILTINS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  [":", async () => 0],
  [
    "exit",
    async (context) => {
      throw new ExitSignal(parseStatus("exit", context.argv[1], context.shell.status));
    },
  ],
  [
    "return",
    async (context) => {
      throw new ReturnSignal(parseStatus("return", context.argv[1], context.shell.status));
    },
  ],
  [
    "break",
    async (context) => {
      throw new LoopSignal("break", loopCount("break", context.argv[1]));
    },
  ],
  [
    "continue",
    async (context) => {
      throw new LoopSignal("continue", loopCount("continue", context.argv[1]));
    },
  ],
  [
    "shift",
    async (context) => {
      const count = context.argv[1] === undefined ? 1 : parseStatus("shift", context.argv[1], 1);
      const parameters = context.shell.positional();
      if (count > parameters.length) return 1;
      context.shell.setPositional(parameters.slice(count));
      return 0;
    },
  ],
  [
    "eval",
    async (context) => {
      const source = context.argv.slice(1).join(" ");
      if (source.trim() === "") return 0;
      return context.shell.runSource(source, { stdin: context.stdin, stdout: context.stdout, stderr: context.stderr });
    },
  ],
  [
    "exec",
    async (context) => {
      if (context.argv.length === 1) {
        // `exec` with only redirections keeps them for the rest of the script.
        context.shell.persistRedirections();
        return 0;
      }
      // There is no process image to replace, so the honest equivalent is to
      // run the command and end the shell with its status.
      const status = await context.shell.invoke(context.argv.slice(1), {
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: context.stderr,
      });
      throw new ExitSignal(status);
    },
  ],
  [
    "export",
    async (context) => {
      const parsed = parseOptions("export", context.argv, { flags: "p" });
      if (parsed.operands.length === 0 || parsed.flags.has("p")) {
        for (const [name, value] of context.shell.environmentEntries()) {
          write(context, `export ${name}=${quoteForDisplay(value)}\n`);
        }
        return 0;
      }
      for (const operand of parsed.operands) {
        const index = operand.indexOf("=");
        const name = index === -1 ? operand : operand.slice(0, index);
        assertName("export", name);
        if (index === -1) context.shell.setExported(name, true);
        else context.shell.assign(name, operand.slice(index + 1), { exported: true });
      }
      return 0;
    },
  ],
  [
    "unset",
    async (context) => {
      const parsed = parseOptions("unset", context.argv, { flags: "fv" });
      for (const name of parsed.operands) {
        assertName("unset", name);
        if (parsed.flags.has("f")) context.shell.functions.delete(name);
        else context.shell.unset(name);
      }
      return 0;
    },
  ],
  ["set", async (context) => applySet(context)],
  ["trap", async (context) => applyTrap(context)],
  [".", async (context) => sourceFile(context)],
  ["source", async (context) => sourceFile(context)],
]);

export const BUILTINS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ["true", async () => 0],
  ["false", async () => 1],
  [
    "cd",
    async (context) => {
      const parsed = parseOptions("cd", context.argv, { flags: "LP" });
      const requested = parsed.operands[0];
      let target: string;
      if (requested === undefined) {
        const home = context.shell.lookup("HOME");
        if (home === undefined) throw new ShellCommandError("HOME not set");
        target = home;
      } else if (requested === "-") {
        const previous = context.shell.lookup("OLDPWD");
        if (previous === undefined) throw new ShellCommandError("OLDPWD not set");
        target = previous;
        write(context, `${previous}\n`);
      } else {
        target = requested;
      }
      const previous = context.shell.fs.cwd;
      context.shell.changeDirectory(context.shell.fs.resolve(target));
      context.shell.assign("OLDPWD", previous, { exported: true });
      return 0;
    },
  ],
  [
    "pwd",
    async (context) => {
      // `-L` and `-P` behave identically: this filesystem has no symlinks, so
      // there is no logical path that could differ from the physical one.
      parseOptions("pwd", context.argv, { flags: "LP" });
      write(context, `${context.shell.fs.cwd}\n`);
      return 0;
    },
  ],
  [
    "echo",
    async (context) => {
      // POSIX leaves `echo` option handling implementation-defined. This one
      // accepts `-n`, `-e`, and `-E` and does not interpret escapes unless
      // `-e` is given, which is stated in the documentation rather than left
      // for a script to discover.
      let index = 1;
      let newline = true;
      let escapes = false;
      for (; index < context.argv.length; index += 1) {
        const argument = context.argv[index];
        if (argument === "-n") newline = false;
        else if (argument === "-e") escapes = true;
        else if (argument === "-E") escapes = false;
        else break;
      }
      const body = context.argv.slice(index).join(" ");
      const rendered = escapes ? expandEscapes(body, 0) : { text: body, stopped: false };
      write(context, `${rendered.text}${newline && !rendered.stopped ? "\n" : ""}`);
      return 0;
    },
  ],
  [
    "printf",
    async (context) => {
      const format = context.argv[1];
      if (format === undefined) throw usageError("printf", "usage: printf format [argument ...]");
      write(context, formatPrintf(format, context.argv.slice(2)));
      return 0;
    },
  ],
  ["test", async (context) => evaluateTest(context.argv.slice(1), context.shell)],
  [
    "[",
    async (context) => {
      const argv = context.argv.slice(1);
      if (argv[argv.length - 1] !== "]") throw usageError("[", "missing `]`");
      return evaluateTest(argv.slice(0, -1), context.shell);
    },
  ],
  [
    "read",
    async (context) => {
      const parsed = parseOptions("read", context.argv, { flags: "r" });
      const names = parsed.operands.length > 0 ? parsed.operands : ["REPLY"];
      for (const name of names) assertName("read", name);
      const line = context.stdin.readLine();
      if (line === undefined) return 1;
      let text = decodeText(line);
      if (!parsed.flags.has("r")) text = text.replace(/\\(.)/gu, "$1");
      const fields = splitReadFields(text, context.shell.lookup("IFS") ?? " \t\n", names.length);
      names.forEach((name, index) => context.shell.assign(name, fields[index] ?? ""));
      return 0;
    },
  ],
  [
    "local",
    async (context) => {
      for (const operand of context.argv.slice(1)) {
        const index = operand.indexOf("=");
        const name = index === -1 ? operand : operand.slice(0, index);
        assertName("local", name);
        context.shell.declareLocal(name);
        context.shell.assign(name, index === -1 ? "" : operand.slice(index + 1));
      }
      return 0;
    },
  ],
  [
    "type",
    async (context) => {
      let status = 0;
      for (const name of context.argv.slice(1)) {
        const alias = context.shell.aliases.get(name);
        if (alias !== undefined) {
          write(context, `${name} is an alias for ${alias}\n`);
          continue;
        }
        const kind = context.shell.resolveKind(name);
        if (kind === "unknown") {
          context.stderr.write(encodeText(`type: ${name}: not found\n`));
          status = 1;
          continue;
        }
        write(context, `${name} is a shell ${kind.replace("-", " ")}\n`);
      }
      return status;
    },
  ],
  [
    "command",
    async (context) => {
      const parsed = parseOptions("command", context.argv, { flags: "vV", stopAtFirstOperand: true });
      const name = parsed.operands[0];
      if (name === undefined) throw usageError("command", "usage: command [-v] name [argument ...]");
      if (parsed.flags.has("v") || parsed.flags.has("V")) {
        const kind = context.shell.resolveKind(name);
        if (kind === "unknown") return 1;
        write(context, parsed.flags.has("V") ? `${name} is a shell ${kind.replace("-", " ")}\n` : `${name}\n`);
        return 0;
      }
      return context.shell.invoke(parsed.operands, {
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: context.stderr,
      });
    },
  ],
  [
    "alias",
    async (context) => {
      if (context.argv.length === 1) {
        for (const [name, value] of [...context.shell.aliases].sort()) {
          write(context, `alias ${name}=${quoteForDisplay(value)}\n`);
        }
        return 0;
      }
      let status = 0;
      for (const operand of context.argv.slice(1)) {
        const index = operand.indexOf("=");
        if (index === -1) {
          const value = context.shell.aliases.get(operand);
          if (value === undefined) {
            context.stderr.write(encodeText(`alias: ${operand}: not found\n`));
            status = 1;
            continue;
          }
          write(context, `alias ${operand}=${quoteForDisplay(value)}\n`);
          continue;
        }
        const name = operand.slice(0, index);
        assertName("alias", name);
        if (!context.shell.aliases.has(name) && context.shell.aliases.size >= AIRSHIP_SH_MAX_ALIASES) {
          throw new ShellCommandError(`airship-sh exceeded ${AIRSHIP_SH_MAX_ALIASES} aliases`);
        }
        context.shell.aliases.set(name, operand.slice(index + 1));
      }
      return status;
    },
  ],
  [
    "unalias",
    async (context) => {
      const parsed = parseOptions("unalias", context.argv, { flags: "a" });
      if (parsed.flags.has("a")) {
        context.shell.aliases.clear();
        return 0;
      }
      let status = 0;
      for (const name of parsed.operands) {
        if (!context.shell.aliases.delete(name)) {
          context.stderr.write(encodeText(`unalias: ${name}: not found\n`));
          status = 1;
        }
      }
      return status;
    },
  ],
]);

function loopCount(command: string, raw: string | undefined): number {
  if (raw === undefined) return 1;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw usageError(command, `loop count must be a positive integer: ${raw}`);
  return Number.parseInt(raw, 10);
}

function assertName(command: string, name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw usageError(command, `not a valid name: ${name}`);
}

async function sourceFile(context: CommandContext): Promise<number> {
  const path = context.argv[1];
  if (path === undefined) throw usageError(context.argv[0], "filename argument required");
  const source = decodeText(context.shell.fs.readFile(context.shell.fs.resolve(path)));
  const extra = context.argv.slice(2);
  const saved = context.shell.positional();
  if (extra.length > 0) context.shell.setPositional(extra);
  try {
    return await context.shell.runSource(source, {
      stdin: context.stdin,
      stdout: context.stdout,
      stderr: context.stderr,
    });
  } finally {
    if (extra.length > 0) context.shell.setPositional(saved);
  }
}

/**
 * `set` does four separate jobs: print variables, toggle short flags, toggle
 * `-o` long options, and replace the positional parameters. Every flag this
 * engine does not implement is rejected by name instead of ignored.
 */
async function applySet(context: CommandContext): Promise<number> {
  const argv = context.argv;
  if (argv.length === 1) {
    for (const name of context.shell.variableNames()) {
      write(context, `${name}=${quoteForDisplay(context.shell.lookup(name) ?? "")}\n`);
    }
    return 0;
  }
  let index = 1;
  let sawPositional = false;
  const positional: string[] = [];
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (sawPositional) {
      positional.push(argument);
      continue;
    }
    if (argument === "--") {
      sawPositional = true;
      continue;
    }
    if (argument !== "-" && (argument.startsWith("-") || argument.startsWith("+"))) {
      const enable = argument.startsWith("-");
      const body = argument.slice(1);
      if (body.startsWith("o")) {
        const inline = body.slice(1);
        const name = inline.length > 0 ? inline : argv[index + 1];
        if (inline.length === 0 && name !== undefined) index += 1;
        if (name === undefined) {
          for (const option of Object.keys(SHELL_OPTION_NAMES) as ShellOptionName[]) {
            write(context, `${option}\t${context.shell.options[option] ? "on" : "off"}\n`);
          }
          continue;
        }
        const option = SHELL_OPTION_NAMES[name];
        if (!option) {
          throw usageError(
            "set",
            `unsupported option name: ${name} (airship-sh implements ${Object.keys(SHELL_OPTION_NAMES).join(", ")})`,
          );
        }
        context.shell.options[option] = enable;
        continue;
      }
      for (const character of body) {
        const option = SHELL_OPTION_FLAGS[character];
        if (!option) throw unsupportedOption("set", `${enable ? "-" : "+"}${character}`);
        context.shell.options[option] = enable;
      }
      continue;
    }
    sawPositional = true;
    positional.push(argument);
  }
  if (sawPositional) context.shell.setPositional(positional);
  return 0;
}

/**
 * `trap` implements EXIT only. Every other condition names a real
 * operating-system signal, and this interpreter has no process to receive one,
 * so refusing them by name is the only honest answer.
 */
async function applyTrap(context: CommandContext): Promise<number> {
  const argv = context.argv;
  if (argv.length === 1) {
    for (const [condition, action] of context.shell.traps) {
      write(context, `trap -- ${quoteForDisplay(action)} ${condition}\n`);
    }
    return 0;
  }
  const action = argv[1];
  const conditions = argv.slice(2);
  if (conditions.length === 0) throw usageError("trap", "usage: trap action EXIT");
  for (const condition of conditions) {
    const normalized = condition.toUpperCase().replace(/^SIG/u, "");
    if (normalized !== "EXIT" && normalized !== "0") {
      throw usageError(
        "trap",
        `airship-sh has no operating-system process, so only EXIT can be trapped; ${condition} is unsupported`,
      );
    }
    if (action === "-" || action === "") context.shell.traps.delete("EXIT");
    else context.shell.traps.set("EXIT", action);
  }
  return 0;
}

function splitReadFields(text: string, ifs: string, count: number): readonly string[] {
  if (ifs === "") return Object.freeze([text]);
  const separators = new Set([...ifs]);
  const whitespaceOnly = [...ifs].every((char) => char === " " || char === "\t" || char === "\n");
  const characters = [...text];
  const fields: string[] = [];
  let current = "";
  let index = 0;
  if (whitespaceOnly) while (index < characters.length && separators.has(characters[index])) index += 1;
  for (; index < characters.length; index += 1) {
    const char = characters[index];
    if (separators.has(char) && fields.length < count - 1) {
      fields.push(current);
      current = "";
      if (whitespaceOnly) while (index + 1 < characters.length && separators.has(characters[index + 1])) index += 1;
      continue;
    }
    current += char;
  }
  fields.push(whitespaceOnly ? current.replace(/[ \t\n]+$/u, "") : current);
  return Object.freeze(fields);
}

/** Shell-safe single-quoted rendering used by `set`, `export -p`, and `alias`. */
export function quoteForDisplay(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

type EscapeResult = Readonly<{ text: string; stopped: boolean; next: number }>;

/** Reads one backslash escape; `\c` stops all further output, as POSIX says. */
function readEscape(text: string, index: number): EscapeResult {
  const next = text[index + 1];
  switch (next) {
    case "n":
      return Object.freeze({ text: "\n", stopped: false, next: index + 2 });
    case "t":
      return Object.freeze({ text: "\t", stopped: false, next: index + 2 });
    case "r":
      return Object.freeze({ text: "\r", stopped: false, next: index + 2 });
    case "a":
      return Object.freeze({ text: "", stopped: false, next: index + 2 });
    case "b":
      return Object.freeze({ text: "\b", stopped: false, next: index + 2 });
    case "f":
      return Object.freeze({ text: "\f", stopped: false, next: index + 2 });
    case "v":
      return Object.freeze({ text: "\v", stopped: false, next: index + 2 });
    case "\\":
      return Object.freeze({ text: "\\", stopped: false, next: index + 2 });
    case "c":
      return Object.freeze({ text: "", stopped: true, next: text.length });
    case "0": {
      const digits = /^[0-7]{1,3}/u.exec(text.slice(index + 2))?.[0] ?? "";
      return Object.freeze({
        text: String.fromCharCode(Number.parseInt(digits === "" ? "0" : digits, 8)),
        stopped: false,
        next: index + 2 + digits.length,
      });
    }
    default:
      return Object.freeze({ text: `\\${next ?? ""}`, stopped: false, next: index + 2 });
  }
}

export function expandEscapes(text: string, from: number): Readonly<{ text: string; stopped: boolean }> {
  let result = "";
  let index = from;
  while (index < text.length) {
    if (text[index] !== "\\") {
      result += text[index];
      index += 1;
      continue;
    }
    const escape = readEscape(text, index);
    result += escape.text;
    index = escape.next;
    if (escape.stopped) return Object.freeze({ text: result, stopped: true });
  }
  return Object.freeze({ text: result, stopped: false });
}

const CONVERSION = /^%([-+ #0]*)([0-9]*)(?:\.([0-9]+))?([diouxXcsb%])/u;

/**
 * `printf` with the POSIX conversions. An unknown conversion is an error
 * rather than a literal echo of the specifier, so a script is never told it
 * formatted something this engine silently skipped. The format string is
 * reused while arguments remain, exactly as POSIX requires.
 */
export function formatPrintf(format: string, args: readonly string[]): string {
  let output = "";
  let argIndex = 0;
  for (;;) {
    const startArg = argIndex;
    let index = 0;
    let sawConversion = false;
    while (index < format.length) {
      const char = format[index];
      if (char === "\\") {
        const escape = readEscape(format, index);
        output += escape.text;
        index = escape.next;
        if (escape.stopped) return output;
        continue;
      }
      if (char !== "%") {
        output += char;
        index += 1;
        continue;
      }
      const match = CONVERSION.exec(format.slice(index));
      if (!match) throw usageError("printf", `unsupported conversion: ${format.slice(index, index + 2)}`);
      const [whole, flags, width, precision, conversion] = match;
      index += whole.length;
      if (conversion === "%") {
        output += "%";
        continue;
      }
      sawConversion = true;
      const argument = args[argIndex] ?? "";
      argIndex += 1;
      output += pad(renderConversion(conversion, argument, precision), flags, width);
    }
    if (!sawConversion || argIndex >= args.length || argIndex === startArg) return output;
  }
}

function renderConversion(conversion: string, argument: string, precision: string | undefined): string {
  switch (conversion) {
    case "s":
      return precision === undefined ? argument : argument.slice(0, Number.parseInt(precision, 10));
    case "b":
      return expandEscapes(argument, 0).text;
    case "c":
      return [...argument][0] ?? "";
    case "d":
    case "i":
      return String(toInteger(argument));
    case "u":
      return String(BigInt.asUintN(64, toInteger(argument)));
    case "o":
      return BigInt.asUintN(64, toInteger(argument)).toString(8);
    case "x":
      return BigInt.asUintN(64, toInteger(argument)).toString(16);
    default:
      return BigInt.asUintN(64, toInteger(argument)).toString(16).toUpperCase();
  }
}

function toInteger(argument: string): bigint {
  const trimmed = argument.trim();
  if (trimmed === "") return 0n;
  if (!/^[+-]?[0-9]+$/u.test(trimmed)) throw usageError("printf", `expected a numeric argument: ${argument}`);
  return BigInt.asIntN(64, BigInt(trimmed));
}

function pad(value: string, flags: string, width: string): string {
  if (width === "") return value;
  const target = Number.parseInt(width, 10);
  if (value.length >= target) return value;
  if (flags.includes("-")) return value.padEnd(target, " ");
  if (flags.includes("0") && /^[+-]?[0-9]+$/u.test(value)) {
    const negative = value.startsWith("-");
    const digits = negative ? value.slice(1) : value;
    return `${negative ? "-" : ""}${digits.padStart(target - (negative ? 1 : 0), "0")}`;
  }
  return value.padStart(target, " ");
}
