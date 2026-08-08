/**
 * Three distinct failure classes, because the shell must never collapse them.
 *
 * - A parse error is a script the grammar refuses, including syntax this
 *   interpreter deliberately does not implement. It is never a silent no-op.
 * - A fatal error ends the whole run: a budget ceiling, the wall-clock
 *   deadline, or cancellation. It is not a command's nonzero exit status.
 * - A command error is an ordinary nonzero exit with a diagnostic on stderr,
 *   exactly as a real utility reports one.
 */
export class ShellParseError extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(`airship-sh: syntax error at line ${line}, column ${column}: ${message}`);
    this.name = "ShellParseError";
  }
}

export type ShellFatalReason = "budget" | "deadline" | "cancelled" | "internal";

export class ShellFatalError extends Error {
  constructor(readonly reason: ShellFatalReason, message: string) {
    super(message);
    this.name = "ShellFatalError";
  }
}

/**
 * A utility or builtin refusing its arguments. Carries the exit status the
 * command must report so a caller never has to guess whether 1 or 2 was meant.
 */
export class ShellCommandError extends Error {
  constructor(message: string, readonly status = 1) {
    super(message);
    this.name = "ShellCommandError";
  }
}

/**
 * An unimplemented flag is an error, never a silently ignored argument.
 *
 * Neither of these puts the command name in the message. `Interpreter.guard`
 * prefixes every `ShellCommandError` it catches with the argv[0] it actually
 * dispatched — which is why `filesystem.ts` and `regex.ts` write their
 * diagnostics without one — and these two wrote it in as well, so the person
 * read it twice: `ls: ls: unsupported option: -Z`. argv[0] is also the more
 * truthful of the two names, because it is the word that was typed: `[ -t 1 ]`
 * is reported as `[`, not as `test`.
 *
 * The parameter stays. Every call site uses it to declare which utility the
 * diagnostic belongs to, and that is worth reading there even though the
 * printed name now comes from the dispatcher.
 */
export function unsupportedOption(_command: string, option: string): ShellCommandError {
  return new ShellCommandError(`unsupported option: ${option}`, 2);
}

export function usageError(_command: string, detail: string): ShellCommandError {
  return new ShellCommandError(detail, 2);
}
