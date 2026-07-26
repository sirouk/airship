/**
 * The parsed shape of a POSIX shell script.
 *
 * Quoting is preserved structurally rather than textually: every part records
 * whether it came from a quoted region, because field splitting and pathname
 * expansion apply only to characters produced by *unquoted* expansions. A
 * flattened string cannot express that, and guessing it later is how shells
 * grow injection bugs.
 */

export type ParameterOperator =
  | "none"
  /** `${x:-w}` / `${x-w}` */
  | "use-default"
  /** `${x:=w}` / `${x=w}` */
  | "assign-default"
  /** `${x:?w}` / `${x?w}` */
  | "error-if-unset"
  /** `${x:+w}` / `${x+w}` */
  | "alternative"
  /** `${x#w}` */
  | "remove-smallest-prefix"
  /** `${x##w}` */
  | "remove-largest-prefix"
  /** `${x%w}` */
  | "remove-smallest-suffix"
  /** `${x%%w}` */
  | "remove-largest-suffix";

export type WordPart =
  | Readonly<{ kind: "literal"; text: string; quoted: boolean }>
  | Readonly<{
      kind: "parameter";
      name: string;
      operator: ParameterOperator;
      /** `:` variants treat an empty value as unset. */
      colon: boolean;
      /** `${#name}` */
      length: boolean;
      argument?: Word;
      quoted: boolean;
    }>
  | Readonly<{ kind: "command"; script: string; quoted: boolean }>
  | Readonly<{ kind: "arithmetic"; source: Word; quoted: boolean }>
  | Readonly<{ kind: "tilde"; user: string }>;

export type Word = readonly WordPart[];

export type RedirectionOperator = ">" | ">>" | "<" | "<>" | ">|" | ">&" | "<&" | "<<";

export type Redirection = Readonly<{
  /** The descriptor the operator applies to; defaults are 1 for output, 0 for input. */
  fd: number;
  operator: RedirectionOperator;
  /** Filename, descriptor word, or here-document delimiter source. */
  target?: Word;
  /** Here-document body, already expanded-or-literal according to its delimiter. */
  here?: Word;
}>;

export type Assignment = Readonly<{ name: string; value: Word }>;

export type CaseItem = Readonly<{ patterns: readonly Word[]; body: CommandList }>;

export type IfClause = Readonly<{ condition: CommandList; body: CommandList }>;

export type Command =
  | Readonly<{
      kind: "simple";
      assignments: readonly Assignment[];
      words: readonly Word[];
      redirections: readonly Redirection[];
    }>
  | Readonly<{ kind: "subshell"; body: CommandList; redirections: readonly Redirection[] }>
  | Readonly<{ kind: "group"; body: CommandList; redirections: readonly Redirection[] }>
  | Readonly<{
      kind: "if";
      clauses: readonly IfClause[];
      otherwise?: CommandList;
      redirections: readonly Redirection[];
    }>
  | Readonly<{
      kind: "for";
      name: string;
      /** Absent means the POSIX default of `"$@"`. */
      words?: readonly Word[];
      body: CommandList;
      redirections: readonly Redirection[];
    }>
  | Readonly<{
      kind: "while";
      /** `until` is `while` with an inverted condition; one node, one executor. */
      invert: boolean;
      condition: CommandList;
      body: CommandList;
      redirections: readonly Redirection[];
    }>
  | Readonly<{ kind: "case"; word: Word; items: readonly CaseItem[]; redirections: readonly Redirection[] }>
  | Readonly<{ kind: "function"; name: string; body: Command }>;

export type Pipeline = Readonly<{ negated: boolean; commands: readonly Command[] }>;

export type AndOrLink = Readonly<{ operator: "&&" | "||"; pipeline: Pipeline }>;

export type AndOrList = Readonly<{ first: Pipeline; rest: readonly AndOrLink[] }>;

export type CommandList = Readonly<{ items: readonly AndOrList[] }>;

export type ShellProgram = Readonly<{ body: CommandList }>;
