import type { CommandContext, CommandHandler } from "./command";
import { ShellCommandError, usageError } from "./errors";
import { baseName, joinPath, parentPath, type ShellFileSystem } from "./filesystem";
import { compilePattern, matchPattern } from "./pattern";
import { parseOptions } from "./options";
import { concatBytes, decodeText, encodeText } from "./streams";
import { emit, emitLine, formatTimestamp, inputLines, joinLines, resolveInputs, warn } from "./utility-support";

/**
 * Filesystem utilities over the mounted workspace.
 *
 * They operate on the same in-memory projection the shell itself uses, so a
 * script sees one coherent tree, and every mutation passes the same
 * writable-region and control-plane guards.
 */
export const FILE_UTILITIES: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ["ls", listDirectory],
  ["cat", concatenate],
  ["cp", copy],
  ["mv", move],
  ["rm", remove],
  ["mkdir", makeDirectory],
  ["rmdir", removeDirectory],
  ["touch", touch],
  ["find", find],
  ["basename", basenameCommand],
  ["dirname", dirnameCommand],
  ["realpath", realpathCommand],
  ["stat", statCommand],
  ["du", diskUsage],
  ["diff", diffCommand],
]);

async function listDirectory(context: CommandContext): Promise<number> {
  const parsed = parseOptions("ls", context.argv, { flags: "aAlR1dF" });
  const fs = context.shell.fs;
  const operands = parsed.operands.length > 0 ? parsed.operands : ["."];
  const showHidden = parsed.flags.has("a") || parsed.flags.has("A");
  const long = parsed.flags.has("l");
  const classify = parsed.flags.has("F");
  let status = 0;
  const directories: string[] = [];
  const files: string[] = [];
  for (const operand of operands) {
    const path = fs.resolve(operand);
    if (!fs.exists(path)) {
      warn(context, "ls", `${operand}: No such file or directory`);
      status = 2;
      continue;
    }
    if (fs.isDirectory(path) && !parsed.flags.has("d")) directories.push(path);
    else files.push(path);
  }
  if (files.length > 0) {
    emit(context, renderEntries(context, files.map((path) => ({ path, label: displayName(files, path, operands, fs) })), { long, classify }));
  }
  const queue = [...directories];
  const multiple = directories.length + files.length > 1 || parsed.flags.has("R");
  while (queue.length > 0) {
    const directory = queue.shift()!;
    context.shell.charge();
    if (multiple) emitLine(context, `${files.length > 0 || directory !== directories[0] ? "\n" : ""}${directory}:`);
    const names = fs.list(directory).filter((name) => showHidden || !name.startsWith("."));
    const entries = names.map((name) => ({ path: joinPath(directory, name), label: name }));
    emit(context, renderEntries(context, entries, { long, classify }));
    if (parsed.flags.has("R")) {
      for (const entry of entries) if (fs.isDirectory(entry.path)) queue.push(entry.path);
    }
  }
  return status;
}

function displayName(
  selected: readonly string[],
  path: string,
  operands: readonly string[],
  fs: ShellFileSystem,
): string {
  const index = selected.indexOf(path);
  const operand = operands.find((candidate) => fs.resolve(candidate) === path);
  return operand ?? (index === -1 ? path : path);
}

function renderEntries(
  context: CommandContext,
  entries: readonly Readonly<{ path: string; label: string }>[],
  options: Readonly<{ long: boolean; classify: boolean }>,
): string {
  const fs = context.shell.fs;
  const lines = entries.map(({ path, label }) => {
    const stat = fs.stat(path);
    const suffix = options.classify && stat.kind === "directory" ? "/" : "";
    if (!options.long) return `${label}${suffix}`;
    // Owner and group are fixed labels: the workspace has no ownership model,
    // and inventing per-file users would be a decorative lie. The permission
    // field reports what is actually true here — never executable, and
    // writable only inside the mounted root or the scratch tree.
    const writable = isWritable(fs, path);
    const mode = `${stat.kind === "directory" ? "d" : "-"}r${writable ? "w" : "-"}-------`;
    return `${mode} 1 airship airship ${String(stat.size).padStart(8)} ${formatTimestamp(stat.updatedAt)} ${label}${suffix}`;
  });
  return joinLines(lines);
}

function isWritable(fs: ShellFileSystem, path: string): boolean {
  try {
    fs.assertWritablePath(path);
    return true;
  } catch {
    return false;
  }
}

async function concatenate(context: CommandContext): Promise<number> {
  const parsed = parseOptions("cat", context.argv, { flags: "nbsu" });
  const inputs = resolveInputs(context, parsed.operands);
  if (!parsed.flags.has("n") && !parsed.flags.has("b") && !parsed.flags.has("s")) {
    // Byte-exact copy, so a binary workspace file survives `cat a > b`.
    context.stdout.write(concatBytes(inputs.map(({ bytes }) => bytes)));
    return 0;
  }
  let counter = 0;
  let previousBlank = false;
  const rendered: string[] = [];
  for (const input of inputs) {
    for (const line of inputLines(input)) {
      context.shell.charge();
      if (parsed.flags.has("s") && line === "" && previousBlank) continue;
      previousBlank = line === "";
      if (parsed.flags.has("b") && line === "") {
        rendered.push("");
        continue;
      }
      if (parsed.flags.has("n") || parsed.flags.has("b")) {
        counter += 1;
        rendered.push(`${String(counter).padStart(6)}\t${line}`);
        continue;
      }
      rendered.push(line);
    }
  }
  emit(context, joinLines(rendered));
  return 0;
}

async function copy(context: CommandContext): Promise<number> {
  const parsed = parseOptions("cp", context.argv, { flags: "rRfp" });
  if (parsed.operands.length < 2) throw usageError("cp", "usage: cp [-rRfp] source... target");
  const fs = context.shell.fs;
  const recursive = parsed.flags.has("r") || parsed.flags.has("R");
  const target = fs.resolve(parsed.operands[parsed.operands.length - 1]);
  const sources = parsed.operands.slice(0, -1);
  const intoDirectory = fs.isDirectory(target);
  if (sources.length > 1 && !intoDirectory) throw usageError("cp", `target is not a directory: ${target}`);
  for (const source of sources) {
    context.shell.charge();
    const from = fs.resolve(source);
    const to = intoDirectory ? joinPath(target, baseName(from)) : target;
    copyPath(context, from, to, recursive);
  }
  return 0;
}

function copyPath(context: CommandContext, from: string, to: string, recursive: boolean): void {
  const fs = context.shell.fs;
  if (fs.isDirectory(from)) {
    if (!recursive) throw new ShellCommandError(`cp: ${from}: is a directory (use -r)`);
    fs.makeDirectory(to, true);
    for (const name of fs.list(from)) {
      context.shell.charge();
      copyPath(context, joinPath(from, name), joinPath(to, name), recursive);
    }
    return;
  }
  fs.writeFile(to, fs.readFile(from));
}

async function move(context: CommandContext): Promise<number> {
  const parsed = parseOptions("mv", context.argv, { flags: "fn" });
  if (parsed.operands.length < 2) throw usageError("mv", "usage: mv [-fn] source... target");
  const fs = context.shell.fs;
  const target = fs.resolve(parsed.operands[parsed.operands.length - 1]);
  const sources = parsed.operands.slice(0, -1);
  const intoDirectory = fs.isDirectory(target);
  if (sources.length > 1 && !intoDirectory) throw usageError("mv", `target is not a directory: ${target}`);
  for (const source of sources) {
    context.shell.charge();
    const from = fs.resolve(source);
    const to = intoDirectory ? joinPath(target, baseName(from)) : target;
    if (parsed.flags.has("n") && fs.exists(to)) continue;
    copyPath(context, from, to, true);
    fs.removeTree(from);
  }
  return 0;
}

async function remove(context: CommandContext): Promise<number> {
  const parsed = parseOptions("rm", context.argv, { flags: "rRfd" });
  const fs = context.shell.fs;
  const force = parsed.flags.has("f");
  if (parsed.operands.length === 0) {
    if (force) return 0;
    throw usageError("rm", "usage: rm [-rRfd] file...");
  }
  let status = 0;
  for (const operand of parsed.operands) {
    context.shell.charge();
    const path = fs.resolve(operand);
    if (!fs.exists(path)) {
      if (force) continue;
      warn(context, "rm", `${operand}: No such file or directory`);
      status = 1;
      continue;
    }
    if (fs.isDirectory(path)) {
      if (parsed.flags.has("r") || parsed.flags.has("R")) {
        fs.removeTree(path);
        continue;
      }
      if (parsed.flags.has("d")) {
        fs.removeDirectory(path);
        continue;
      }
      warn(context, "rm", `${operand}: is a directory`);
      status = 1;
      continue;
    }
    fs.removeFile(path);
  }
  return status;
}

async function makeDirectory(context: CommandContext): Promise<number> {
  const parsed = parseOptions("mkdir", context.argv, { flags: "p" });
  if (parsed.operands.length === 0) throw usageError("mkdir", "usage: mkdir [-p] directory...");
  for (const operand of parsed.operands) {
    context.shell.charge();
    context.shell.fs.makeDirectory(context.shell.fs.resolve(operand), parsed.flags.has("p"));
  }
  return 0;
}

async function removeDirectory(context: CommandContext): Promise<number> {
  const parsed = parseOptions("rmdir", context.argv, { flags: "p" });
  if (parsed.operands.length === 0) throw usageError("rmdir", "usage: rmdir [-p] directory...");
  for (const operand of parsed.operands) {
    context.shell.charge();
    let path = context.shell.fs.resolve(operand);
    context.shell.fs.removeDirectory(path);
    while (parsed.flags.has("p")) {
      path = parentPath(path);
      if (path === "/" || context.shell.fs.list(path).length > 0) break;
      context.shell.fs.removeDirectory(path);
    }
  }
  return 0;
}

async function touch(context: CommandContext): Promise<number> {
  const parsed = parseOptions("touch", context.argv, { flags: "c" });
  if (parsed.operands.length === 0) throw usageError("touch", "usage: touch [-c] file...");
  for (const operand of parsed.operands) {
    context.shell.charge();
    const path = context.shell.fs.resolve(operand);
    if (parsed.flags.has("c") && !context.shell.fs.exists(path)) continue;
    context.shell.fs.touch(path);
  }
  return 0;
}

type FindTest = Readonly<{ kind: "name" | "path"; pattern: string } | { kind: "type"; value: "f" | "d" }>;

/**
 * `find` with the predicates this engine can answer honestly. Expression
 * operators (`-o`, `-a`, `!`, parentheses) and actions other than `-print`
 * are rejected by name rather than silently dropped.
 */
async function find(context: CommandContext): Promise<number> {
  const argv = context.argv.slice(1);
  const roots: string[] = [];
  const tests: FindTest[] = [];
  let maxDepth = Number.POSITIVE_INFINITY;
  let minDepth = 0;
  let index = 0;
  while (index < argv.length && !argv[index].startsWith("-")) {
    roots.push(argv[index]);
    index += 1;
  }
  for (; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    switch (option) {
      case "-name":
      case "-path": {
        if (value === undefined) throw usageError("find", `${option} requires a pattern`);
        tests.push(Object.freeze({ kind: option === "-name" ? "name" : "path", pattern: value }));
        index += 1;
        break;
      }
      case "-type": {
        if (value !== "f" && value !== "d") throw usageError("find", "-type accepts only f or d in airship-sh");
        tests.push(Object.freeze({ kind: "type", value }));
        index += 1;
        break;
      }
      case "-maxdepth": {
        if (value === undefined) throw usageError("find", "-maxdepth requires a number");
        maxDepth = Number.parseInt(value, 10);
        index += 1;
        break;
      }
      case "-mindepth": {
        if (value === undefined) throw usageError("find", "-mindepth requires a number");
        minDepth = Number.parseInt(value, 10);
        index += 1;
        break;
      }
      case "-print":
        break;
      default:
        throw usageError("find", `unsupported predicate: ${option}`);
    }
  }
  const fs = context.shell.fs;
  const matches: string[] = [];
  for (const root of roots.length > 0 ? roots : ["."]) {
    const start = fs.resolve(root);
    if (!fs.exists(start)) {
      warn(context, "find", `${root}: No such file or directory`);
      continue;
    }
    const walk = (path: string, display: string, depth: number): void => {
      context.shell.charge();
      if (depth >= minDepth && matchesFind(context, path, display, tests)) matches.push(display);
      if (depth >= maxDepth || !fs.isDirectory(path)) return;
      for (const name of fs.list(path)) walk(joinPath(path, name), `${display === "/" ? "" : display}/${name}`, depth + 1);
    };
    walk(start, root === "." ? "." : root, 0);
  }
  emit(context, joinLines(matches));
  return 0;
}

function matchesFind(context: CommandContext, path: string, display: string, tests: readonly FindTest[]): boolean {
  for (const test of tests) {
    context.shell.charge();
    if (test.kind === "type") {
      const isDirectory = context.shell.fs.isDirectory(path);
      if (test.value === "d" !== isDirectory) return false;
      continue;
    }
    const subject = test.kind === "name" ? baseName(display) : display;
    const pattern = compilePattern([Object.freeze({ text: test.pattern, quoted: false })]);
    if (!matchPattern(pattern, subject)) return false;
  }
  return true;
}

async function basenameCommand(context: CommandContext): Promise<number> {
  const argv = context.argv.slice(1);
  if (argv.length === 0 || argv.length > 2) throw usageError("basename", "usage: basename string [suffix]");
  let name = baseName(argv[0].replace(/\/+$/u, "") || "/");
  const suffix = argv[1];
  if (suffix !== undefined && name !== suffix && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  emitLine(context, name);
  return 0;
}

async function dirnameCommand(context: CommandContext): Promise<number> {
  const argv = context.argv.slice(1);
  if (argv.length !== 1) throw usageError("dirname", "usage: dirname string");
  const trimmed = argv[0].replace(/\/+$/u, "");
  emitLine(context, trimmed.includes("/") ? parentPath(trimmed) || "/" : ".");
  return 0;
}

async function realpathCommand(context: CommandContext): Promise<number> {
  const parsed = parseOptions("realpath", context.argv, { flags: "em" });
  if (parsed.operands.length === 0) throw usageError("realpath", "usage: realpath [-e|-m] path...");
  let status = 0;
  for (const operand of parsed.operands) {
    const path = context.shell.fs.resolve(operand);
    if (!parsed.flags.has("m") && !context.shell.fs.exists(path)) {
      warn(context, "realpath", `${operand}: No such file or directory`);
      status = 1;
      continue;
    }
    emitLine(context, path);
  }
  return status;
}

async function statCommand(context: CommandContext): Promise<number> {
  const parsed = parseOptions("stat", context.argv, { values: "c", longValues: ["--format"] });
  const format = parsed.values.get("c") ?? parsed.values.get("--format");
  if (parsed.operands.length === 0) throw usageError("stat", "usage: stat [-c format] file...");
  let status = 0;
  for (const operand of parsed.operands) {
    context.shell.charge();
    const path = context.shell.fs.resolve(operand);
    if (!context.shell.fs.exists(path)) {
      warn(context, "stat", `${operand}: No such file or directory`);
      status = 1;
      continue;
    }
    const info = context.shell.fs.stat(path);
    const fields: Readonly<Record<string, string>> = Object.freeze({
      n: operand,
      N: path,
      s: String(info.size),
      F: info.kind === "directory" ? "directory" : "regular file",
      y: formatTimestamp(info.updatedAt),
      Y: String(Math.floor(new Date(info.updatedAt).getTime() / 1_000)),
    });
    if (format === undefined) {
      emitLine(context, `  File: ${operand}\n  Size: ${fields.s}\t${fields.F}\nModify: ${fields.y}`);
      continue;
    }
    emitLine(
      context,
      format.replace(/%(.)/gu, (_whole, key: string) => {
        const value = fields[key];
        if (value === undefined) throw usageError("stat", `unsupported format directive: %${key}`);
        return value;
      }),
    );
  }
  return status;
}

async function diskUsage(context: CommandContext): Promise<number> {
  const parsed = parseOptions("du", context.argv, { flags: "ask" });
  const fs = context.shell.fs;
  const blockBytes = parsed.flags.has("k") ? 1_024 : 512;
  const roots = parsed.operands.length > 0 ? parsed.operands : ["."];
  for (const root of roots) {
    const start = fs.resolve(root);
    if (!fs.exists(start)) {
      warn(context, "du", `${root}: No such file or directory`);
      continue;
    }
    const report = (path: string, display: string): number => {
      context.shell.charge();
      if (!fs.isDirectory(path)) {
        const blocks = Math.ceil(fs.stat(path).size / blockBytes);
        if (parsed.flags.has("a") && !parsed.flags.has("s")) emitLine(context, `${blocks}\t${display}`);
        return blocks;
      }
      let total = 0;
      for (const name of fs.list(path)) total += report(joinPath(path, name), `${display}/${name}`);
      if (!parsed.flags.has("s")) emitLine(context, `${total}\t${display}`);
      return total;
    };
    const total = report(start, root);
    if (parsed.flags.has("s")) emitLine(context, `${total}\t${root}`);
  }
  return 0;
}

/**
 * Unified `diff`. The hunk algorithm is a plain longest-common-subsequence
 * walk over lines: correct and bounded, not a heuristic that could report a
 * smaller diff than actually exists.
 */
async function diffCommand(context: CommandContext): Promise<number> {
  const parsed = parseOptions("diff", context.argv, { flags: "uq" });
  if (parsed.operands.length !== 2) throw usageError("diff", "usage: diff [-u] [-q] file1 file2");
  const [leftName, rightName] = parsed.operands;
  const inputs = resolveInputs(context, parsed.operands);
  const left = inputLines(inputs[0]);
  const right = inputLines(inputs[1]);
  if (left.length === right.length && left.every((line, index) => line === right[index])) return 0;
  if (parsed.flags.has("q")) {
    emitLine(context, `Files ${leftName} and ${rightName} differ`);
    return 1;
  }
  context.shell.charge(left.length * right.length);
  const script = unifiedDiff(left, right);
  emit(context, `--- ${leftName}\n+++ ${rightName}\n${joinLines(script)}`);
  return 1;
}

function unifiedDiff(left: readonly string[], right: readonly string[]): readonly string[] {
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const output: string[] = [`@@ -1,${left.length} +1,${right.length} @@`];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      output.push(` ${left[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      output.push(`-${left[i]}`);
      i += 1;
      continue;
    }
    output.push(`+${right[j]}`);
    j += 1;
  }
  while (i < left.length) {
    output.push(`-${left[i]}`);
    i += 1;
  }
  while (j < right.length) {
    output.push(`+${right[j]}`);
    j += 1;
  }
  return Object.freeze(output);
}

export const FILE_UTILITY_HELPERS = Object.freeze({ decodeText, encodeText });
