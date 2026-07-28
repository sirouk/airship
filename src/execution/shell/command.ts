import type { Command } from "./ast";
import type { ShellFileSystem } from "./filesystem";
import type { ByteReader, ByteSink } from "./streams";

export type ShellOptionName = "errexit" | "nounset" | "xtrace" | "noglob" | "pipefail";

export type ShellOptions = Record<ShellOptionName, boolean>;

/** The single-letter `set` flags this interpreter implements, and no others. */
export const SHELL_OPTION_FLAGS: Readonly<Record<string, ShellOptionName>> = Object.freeze({
  e: "errexit",
  u: "nounset",
  x: "xtrace",
  f: "noglob",
});

export const SHELL_OPTION_NAMES: Readonly<Record<string, ShellOptionName>> = Object.freeze({
  errexit: "errexit",
  nounset: "nounset",
  xtrace: "xtrace",
  noglob: "noglob",
  pipefail: "pipefail",
});

export type CommandIo = Readonly<{ stdin: ByteReader; stdout: ByteSink; stderr: ByteSink }>;

export type CommandKind = "special-builtin" | "builtin" | "function" | "utility" | "unknown";

/**
 * What a builtin or utility may reach.
 *
 * Deliberately narrow: a command sees its argv, three streams, and the shell
 * runtime. There is no ambient DOM, network, storage, or host binding to
 * reach, which is the same boundary every other Airship execution tier keeps.
 */
export interface ShellRuntime {
  readonly fs: ShellFileSystem;
  readonly options: ShellOptions;
  /** Stands in for a process id. There is no process; see `$$` in the docs. */
  readonly runId: number;
  readonly startedAt: Date;
  status: number;
  scriptName: string;
  readonly functions: Map<string, Command>;
  readonly aliases: Map<string, string>;
  readonly traps: Map<string, string>;

  charge(steps?: number): void;
  tick(steps?: number): Promise<void>;

  lookup(name: string): string | undefined;
  assign(name: string, value: string, options?: Readonly<{ exported?: boolean }>): void;
  unset(name: string): void;
  isExported(name: string): boolean;
  setExported(name: string, exported: boolean): void;
  variableNames(): readonly string[];
  environmentEntries(): readonly (readonly [string, string])[];

  positional(): readonly string[];
  setPositional(values: readonly string[]): void;

  /** Moves the filesystem cursor and keeps the exported `PWD` in step. */
  changeDirectory(path: string): void;
  /** `exec` with redirections and no command keeps them for the whole shell. */
  persistRedirections(): void;
  /**
   * Declares a function-scoped variable. Throws outside a function, because a
   * `local` that silently became global would be a quiet correctness bug.
   */
  declareLocal(name: string): void;

  /** `eval`, `.`/`source`, and `trap` handlers all re-enter here. */
  runSource(source: string, io: CommandIo): Promise<number>;
  /** Resolves and runs one already-expanded argv; used by `command`, `env`, `xargs`. */
  invoke(argv: readonly string[], io: CommandIo): Promise<number>;
  resolveKind(name: string): CommandKind;
}

export type CommandContext = Readonly<{
  argv: readonly string[];
  stdin: ByteReader;
  stdout: ByteSink;
  stderr: ByteSink;
  shell: ShellRuntime;
}>;

export type CommandHandler = (context: CommandContext) => Promise<number>;

/**
 * A parsed option list.
 *
 * Every utility in this engine declares exactly which options it implements.
 * An option outside that declaration is an error: silently ignoring `-Z` would
 * make a script that asked for something specific look like it succeeded.
 */
export type ParsedOptions = Readonly<{
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
  operands: readonly string[];
}>;
