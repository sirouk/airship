import type { CommandContext } from "./command";
import { ShellCommandError } from "./errors";
import { decodeText, encodeText, splitLines } from "./streams";

export type NamedInput = Readonly<{ name: string; bytes: Uint8Array }>;

/**
 * Resolves a utility's operands to inputs. No operand — or a bare `-` — means
 * standard input, which is how every POSIX filter behaves.
 */
export function resolveInputs(context: CommandContext, operands: readonly string[]): readonly NamedInput[] {
  if (operands.length === 0) return Object.freeze([Object.freeze({ name: "-", bytes: context.stdin.readAll() })]);
  return Object.freeze(
    operands.map((operand) => {
      context.shell.charge();
      if (operand === "-") return Object.freeze({ name: "-", bytes: context.stdin.readAll() });
      const path = context.shell.fs.resolve(operand);
      return Object.freeze({ name: operand, bytes: context.shell.fs.readFile(path) });
    }),
  );
}

export function emit(context: CommandContext, text: string): void {
  context.stdout.write(encodeText(text));
}

export function emitLine(context: CommandContext, text: string): void {
  context.stdout.write(encodeText(`${text}\n`));
}

export function warn(context: CommandContext, command: string, message: string): void {
  context.stderr.write(encodeText(`${command}: ${message}\n`));
}

export function inputLines(input: NamedInput): readonly string[] {
  return splitLines(input.bytes).lines;
}

export function inputText(input: NamedInput): string {
  return decodeText(input.bytes);
}

/** Rejoins lines, restoring the trailing newline a text utility normally emits. */
export function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function requirePositiveInteger(command: string, raw: string, label: string): number {
  if (!/^[0-9]+$/u.test(raw)) throw new ShellCommandError(`${command}: invalid ${label}: ${raw}`, 2);
  return Number.parseInt(raw, 10);
}

export function formatTimestamp(iso: string): string {
  // A fixed, sortable rendering. There is no locale or timezone database here,
  // so the shell reports UTC rather than implying a local clock it cannot know.
  return iso.replace("T", " ").replace(/\.\d+Z$/u, "Z");
}
