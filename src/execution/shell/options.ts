import type { ParsedOptions } from "./command";
import { unsupportedOption, usageError } from "./errors";

export type OptionSpec = Readonly<{
  /** Single-character boolean options. */
  flags?: string;
  /** Single-character options that consume a value. */
  values?: string;
  /** Long boolean options, written with their leading dashes. */
  longFlags?: readonly string[];
  /** Long options that consume a value, as `--name=value` or `--name value`. */
  longValues?: readonly string[];
  /** When true, the first non-option argument ends option parsing (`env`, `xargs`). */
  stopAtFirstOperand?: boolean;
}>;

/**
 * Strict option parsing.
 *
 * An option a utility did not declare produces an error rather than an operand
 * or a silent no-op. That is the whole point: a script that asks for behaviour
 * this engine does not implement must be told, not quietly given something else.
 */
export function parseOptions(command: string, argv: readonly string[], spec: OptionSpec): ParsedOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: string[] = [];
  const booleanChars = new Set(spec.flags ?? "");
  const valueChars = new Set(spec.values ?? "");
  const longFlags = new Set(spec.longFlags ?? []);
  const longValues = new Set(spec.longValues ?? []);
  let index = 1;
  let optionsEnded = false;

  while (index < argv.length) {
    const argument = argv[index];
    if (optionsEnded || argument === "-" || !argument.startsWith("-")) {
      operands.push(argument);
      index += 1;
      if (spec.stopAtFirstOperand === true && !optionsEnded) {
        optionsEnded = true;
        continue;
      }
      continue;
    }
    if (argument === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals === -1 ? argument : argument.slice(0, equals);
      if (longFlags.has(name)) {
        if (equals !== -1) throw usageError(command, `option ${name} does not take a value`);
        flags.add(name);
        index += 1;
        continue;
      }
      if (longValues.has(name)) {
        if (equals !== -1) {
          values.set(name, argument.slice(equals + 1));
          index += 1;
          continue;
        }
        const next = argv[index + 1];
        if (next === undefined) throw usageError(command, `option ${name} requires a value`);
        values.set(name, next);
        index += 2;
        continue;
      }
      throw unsupportedOption(command, name);
    }
    const characters = [...argument.slice(1)];
    let consumedNext = false;
    for (const [position, character] of characters.entries()) {
      if (booleanChars.has(character)) {
        flags.add(character);
        continue;
      }
      if (valueChars.has(character)) {
        const inline = characters.slice(position + 1).join("");
        if (inline.length > 0) {
          values.set(character, inline);
          break;
        }
        const next = argv[index + 1];
        if (next === undefined) throw usageError(command, `option -${character} requires a value`);
        values.set(character, next);
        consumedNext = true;
        break;
      }
      throw unsupportedOption(command, `-${character}`);
    }
    index += consumedNext ? 2 : 1;
  }

  return Object.freeze({ flags: flags, values, operands: Object.freeze(operands) });
}

export function requireOperands(command: string, operands: readonly string[], minimum: number, usage: string): void {
  if (operands.length < minimum) throw usageError(command, `usage: ${usage}`);
}

export function parseCount(command: string, raw: string, label: string): number {
  if (!/^[+-]?[0-9]+$/u.test(raw)) throw usageError(command, `invalid ${label}: ${raw}`);
  return Number.parseInt(raw, 10);
}
