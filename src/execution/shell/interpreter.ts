import type { AndOrList, Command, CommandList, Pipeline, Redirection, Word } from "./ast";
import { BUILTINS, SPECIAL_BUILTINS } from "./builtins";
import type { ShellBudget } from "./budget";
import type { CommandContext, CommandIo, CommandKind, ShellOptions, ShellRuntime } from "./command";
import { AIRSHIP_SH_MAX_DEPTH, AIRSHIP_SH_MAX_POSITIONAL, AIRSHIP_SH_MAX_VARIABLES, AIRSHIP_SH_STATUS } from "./contract";
import { ShellCommandError, ShellFatalError, ShellParseError } from "./errors";
import { expandToFields, expandToPattern, expandToString, type ExpansionHost } from "./expansion";
import type { ShellFileSystem } from "./filesystem";
import { tokenize } from "./lexer";
import { parseShellScript } from "./parser";
import { compilePattern, matchPattern } from "./pattern";
import { ExitSignal, LoopSignal, ReturnSignal } from "./signals";
import { ByteReader, concatBytes, encodeText, NULL_SINK, PipeBuffer, type ByteSink } from "./streams";
import { UTILITIES } from "./utilities";

type Descriptor =
  | Readonly<{ direction: "read"; reader: ByteReader }>
  | Readonly<{ direction: "write"; sink: ByteSink }>;

type Descriptors = Map<number, Descriptor>;

type Variable = { value: string; exported: boolean };

export type InterpreterOptions = Readonly<{
  fs: ShellFileSystem;
  budget: ShellBudget;
  stdout: ByteSink;
  stderr: ByteSink;
  stdin?: ByteReader;
  environment?: Readonly<Record<string, string>>;
  positional?: readonly string[];
  scriptName?: string;
  runId?: number;
}>;

/**
 * Writes to a mounted file.
 *
 * Bytes are buffered and flushed when the redirection closes rather than on
 * every write, because the in-memory filesystem replaces whole file contents;
 * flushing per write would make `while ...; do echo >> f; done` quadratic.
 */
class FileSink implements ByteSink {
  private chunks: Uint8Array[] = [];

  constructor(
    private readonly fs: ShellFileSystem,
    private readonly path: string,
    append: boolean,
  ) {
    // `>` truncates when the redirection is set up, before the command runs,
    // exactly as a real shell's `O_TRUNC` does.
    if (!append || !fs.isFile(path)) fs.writeFile(path, new Uint8Array());
  }

  write(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }

  close(): void {
    if (this.chunks.length === 0) return;
    const payload = concatBytes(this.chunks);
    this.chunks = [];
    this.fs.writeFile(this.path, payload, { append: true });
  }
}

export class Interpreter implements ShellRuntime {
  readonly fs: ShellFileSystem;
  readonly options: ShellOptions;
  readonly runId: number;
  readonly startedAt = new Date();
  readonly functions = new Map<string, Command>();
  readonly aliases = new Map<string, string>();
  readonly traps = new Map<string, string>();
  status = 0;
  scriptName: string;

  private readonly budget: ShellBudget;
  private readonly variables = new Map<string, Variable>();
  private parameters: string[];
  private readonly rootIo: CommandIo;
  private activeIo: CommandIo;
  private conditionDepth = 0;
  private depth = 0;
  private lastSubstitutionStatus = 0;
  private persistNextRedirections = false;
  private readonly persistentSinks = new Set<FileSink>();
  private readonly localFrames: Map<string, Variable | undefined>[] = [];

  constructor(options: InterpreterOptions) {
    this.fs = options.fs;
    this.budget = options.budget;
    this.runId = options.runId ?? 1;
    this.scriptName = options.scriptName ?? "airship-sh";
    this.parameters = [...(options.positional ?? [])];
    this.options = { errexit: false, nounset: false, xtrace: false, noglob: false, pipefail: false };
    this.rootIo = Object.freeze({
      stdin: options.stdin ?? ByteReader.empty(),
      stdout: options.stdout,
      stderr: options.stderr,
    });
    this.activeIo = this.rootIo;
    for (const [name, value] of Object.entries(options.environment ?? {})) {
      this.variables.set(name, { value, exported: true });
    }
    if (!this.variables.has("IFS")) this.variables.set("IFS", { value: " \t\n", exported: false });
    this.variables.set("PWD", { value: this.fs.cwd, exported: true });
    if (!this.variables.has("HOME")) this.variables.set("HOME", { value: this.fs.root, exported: true });
  }

  // --- ShellRuntime -------------------------------------------------------

  charge(steps = 1): void {
    this.budget.charge(steps);
  }

  async tick(steps = 1): Promise<void> {
    await this.budget.tick(steps);
  }

  lookup(name: string): string | undefined {
    return this.variables.get(name)?.value;
  }

  assign(name: string, value: string, options: Readonly<{ exported?: boolean }> = {}): void {
    const existing = this.variables.get(name);
    if (!existing && this.variables.size >= AIRSHIP_SH_MAX_VARIABLES) {
      throw new ShellCommandError(`airship-sh exceeded ${AIRSHIP_SH_MAX_VARIABLES} shell variables`);
    }
    this.variables.set(name, { value, exported: options.exported ?? existing?.exported ?? false });
  }

  unset(name: string): void {
    this.variables.delete(name);
  }

  isExported(name: string): boolean {
    return this.variables.get(name)?.exported === true;
  }

  setExported(name: string, exported: boolean): void {
    const existing = this.variables.get(name);
    if (existing) existing.exported = exported;
    else this.variables.set(name, { value: "", exported });
  }

  variableNames(): readonly string[] {
    return Object.freeze([...this.variables.keys()].sort());
  }

  environmentEntries(): readonly (readonly [string, string])[] {
    return Object.freeze(
      [...this.variables.entries()]
        .filter(([, variable]) => variable.exported)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, variable]) => Object.freeze([name, variable.value] as const)),
    );
  }

  positional(): readonly string[] {
    return Object.freeze([...this.parameters]);
  }

  setPositional(values: readonly string[]): void {
    if (values.length > AIRSHIP_SH_MAX_POSITIONAL) {
      throw new ShellCommandError(`airship-sh exceeded ${AIRSHIP_SH_MAX_POSITIONAL} positional parameters`);
    }
    this.parameters = [...values];
  }

  /** `cd` updates both the filesystem cursor and the exported `PWD`. */
  changeDirectory(path: string): void {
    this.fs.changeDirectory(path);
    this.assign("PWD", this.fs.cwd, { exported: true });
  }

  /** `exec` with redirections and no command keeps them for the whole shell. */
  persistRedirections(): void {
    this.persistNextRedirections = true;
  }

  /**
   * `local` records the caller's binding so the function frame can restore it.
   * Outside a function there is no frame to restore, and silently making the
   * variable global would be a quiet correctness bug, so it is an error.
   */
  declareLocal(name: string): void {
    const frame = this.localFrames[this.localFrames.length - 1];
    if (!frame) throw new ShellCommandError("local: can only be used in a function", 1);
    if (frame.has(name)) return;
    frame.set(name, this.variables.get(name));
  }

  async runSource(source: string, io: CommandIo): Promise<number> {
    const program = parseShellScript(source);
    const previous = this.activeIo;
    this.activeIo = io;
    try {
      return await this.executeList(program.body, this.descriptorsFor(io));
    } finally {
      this.activeIo = previous;
    }
  }

  async invoke(argv: readonly string[], io: CommandIo): Promise<number> {
    return this.dispatch(argv, io);
  }

  resolveKind(name: string): CommandKind {
    if (SPECIAL_BUILTINS.has(name)) return "special-builtin";
    if (this.functions.has(name)) return "function";
    if (BUILTINS.has(name)) return "builtin";
    if (UTILITIES.has(name)) return "utility";
    return "unknown";
  }

  // --- entry point --------------------------------------------------------

  /** Runs a whole script and returns its exit status, EXIT trap included. */
  async run(source: string): Promise<number> {
    let status = 0;
    try {
      const program = parseShellScript(source);
      status = await this.executeList(program.body, this.descriptorsFor(this.rootIo));
    } catch (error) {
      status = this.reportTerminalError(error);
    }
    status = await this.runExitTrap(status);
    this.flushPersistentSinks();
    return status;
  }

  private reportTerminalError(error: unknown): number {
    if (error instanceof ExitSignal) return error.status;
    if (error instanceof ReturnSignal) return error.status;
    if (error instanceof LoopSignal) {
      this.rootIo.stderr.write(encodeText(`airship-sh: ${error.kind}: only meaningful in a loop\n`));
      return AIRSHIP_SH_STATUS.usage;
    }
    if (error instanceof ShellParseError) {
      this.rootIo.stderr.write(encodeText(`${error.message}\n`));
      return AIRSHIP_SH_STATUS.usage;
    }
    if (error instanceof ShellCommandError) {
      this.rootIo.stderr.write(encodeText(`airship-sh: ${error.message}\n`));
      return error.status;
    }
    throw error;
  }

  private async runExitTrap(status: number): Promise<number> {
    const handler = this.traps.get("EXIT");
    if (handler === undefined) return status;
    // The trap runs once, and only an `exit` inside it may change the script's
    // status. A handler that merely prints must not silently turn `exit 4`
    // into a success.
    this.traps.delete("EXIT");
    this.status = status;
    try {
      await this.runSource(handler, this.rootIo);
    } catch (error) {
      return this.reportTerminalError(error);
    }
    return status;
  }

  // --- execution ----------------------------------------------------------

  private async executeList(list: CommandList, fds: Descriptors): Promise<number> {
    let status = this.status;
    for (const item of list.items) {
      status = await this.executeAndOr(item, fds);
      this.status = status;
      if (this.options.errexit && status !== 0 && this.conditionDepth === 0) throw new ExitSignal(status);
    }
    return status;
  }

  private async executeAndOr(list: AndOrList, fds: Descriptors): Promise<number> {
    const total = list.rest.length;
    let status = await this.withCondition(total > 0, () => this.executePipeline(list.first, fds));
    this.status = status;
    for (const [index, link] of list.rest.entries()) {
      if (link.operator === "&&" && status !== 0) continue;
      if (link.operator === "||" && status === 0) continue;
      const isLast = index === total - 1;
      status = await this.withCondition(!isLast, () => this.executePipeline(link.pipeline, fds));
      this.status = status;
    }
    return status;
  }

  /**
   * Pipeline stages run in order, each writing into a bounded buffer the next
   * stage reads. This is a real semantic difference from a process shell:
   * stages do not run concurrently, so an unbounded producer feeding `head`
   * fills the pipe budget and fails rather than receiving SIGPIPE.
   */
  private async executePipeline(pipeline: Pipeline, fds: Descriptors): Promise<number> {
    await this.tick();
    if (pipeline.commands.length === 1 && !pipeline.negated) {
      return this.executeCommand(pipeline.commands[0], fds);
    }
    const statuses: number[] = [];
    let input = readerFor(fds, 0);
    for (const [index, command] of pipeline.commands.entries()) {
      const last = index === pipeline.commands.length - 1;
      const buffer = last ? undefined : new PipeBuffer();
      const stage: Descriptors = new Map(fds);
      stage.set(0, { direction: "read", reader: input });
      if (buffer) stage.set(1, { direction: "write", sink: buffer });
      statuses.push(await this.withCondition(true, () => this.executeCommand(command, stage)));
      input = buffer ? new ByteReader(buffer.bytes()) : ByteReader.empty();
    }
    const failure = statuses.find((value) => value !== 0);
    const status = this.options.pipefail && failure !== undefined ? failure : statuses[statuses.length - 1];
    return pipeline.negated ? (status === 0 ? 1 : 0) : status;
  }

  private async executeCommand(command: Command, fds: Descriptors): Promise<number> {
    await this.tick();
    if (command.kind === "function") {
      this.functions.set(command.name, command.body);
      return 0;
    }
    if (command.kind === "simple") return this.executeSimple(command, fds);

    const applied = await this.applyRedirections(command.redirections, fds);
    try {
      switch (command.kind) {
        case "group":
          return await this.executeList(command.body, applied.fds);
        case "subshell":
          return await this.runSubshell((child) => child.executeList(command.body, applied.fds));
        case "if":
          return await this.executeIf(command, applied.fds);
        case "for":
          return await this.executeFor(command, applied.fds);
        case "while":
          return await this.executeWhile(command, applied.fds);
        case "case":
          return await this.executeCase(command, applied.fds);
      }
    } finally {
      applied.close();
    }
  }

  private async executeIf(command: Extract<Command, { kind: "if" }>, fds: Descriptors): Promise<number> {
    for (const clause of command.clauses) {
      const condition = await this.withCondition(true, () => this.executeList(clause.condition, fds));
      if (condition === 0) return this.executeList(clause.body, fds);
    }
    if (command.otherwise) return this.executeList(command.otherwise, fds);
    return 0;
  }

  private async executeFor(command: Extract<Command, { kind: "for" }>, fds: Descriptors): Promise<number> {
    const values: string[] = [];
    if (command.words) {
      for (const word of command.words) values.push(...(await expandToFields(word, this.expansionHost())));
    } else {
      values.push(...this.parameters);
    }
    let status = 0;
    for (const value of values) {
      await this.tick();
      this.assign(command.name, value);
      try {
        status = await this.executeList(command.body, fds);
      } catch (error) {
        const outcome = this.handleLoopSignal(error);
        if (outcome === "break") return status;
        if (outcome === "continue") continue;
        throw error;
      }
    }
    return status;
  }

  private async executeWhile(command: Extract<Command, { kind: "while" }>, fds: Descriptors): Promise<number> {
    let status = 0;
    for (;;) {
      await this.tick();
      const condition = await this.withCondition(true, () => this.executeList(command.condition, fds));
      const satisfied = command.invert ? condition !== 0 : condition === 0;
      if (!satisfied) return status;
      try {
        status = await this.executeList(command.body, fds);
      } catch (error) {
        const outcome = this.handleLoopSignal(error);
        if (outcome === "break") return status;
        if (outcome === "continue") continue;
        throw error;
      }
    }
  }

  private async executeCase(command: Extract<Command, { kind: "case" }>, fds: Descriptors): Promise<number> {
    const subject = await expandToString(command.word, this.expansionHost());
    for (const item of command.items) {
      for (const pattern of item.patterns) {
        this.charge();
        const segments = await expandToPattern(pattern, this.expansionHost());
        if (!matchPattern(compilePattern(segments), subject)) continue;
        return item.body.items.length === 0 ? 0 : this.executeList(item.body, fds);
      }
    }
    return 0;
  }

  private async executeSimple(command: Extract<Command, { kind: "simple" }>, fds: Descriptors): Promise<number> {
    const previousIo = this.activeIo;
    this.activeIo = ioFor(fds, this.rootIo);
    let argv: string[] = [];
    try {
      for (const word of command.words) argv.push(...(await expandToFields(word, this.expansionHost())));
      argv = await this.expandAliases(argv);
    } finally {
      this.activeIo = previousIo;
    }

    const applied = await this.applyRedirections(command.redirections, fds);
    const io = ioFor(applied.fds, this.rootIo);
    if (argv.length === 0) {
      // A bare assignment list still performs its redirections, so `> out`
      // truncates, and `x=$(cmd)` reports the substitution's own status.
      try {
        this.lastSubstitutionStatus = 0;
        for (const assignment of command.assignments) {
          this.assign(assignment.name, await this.expandAssignmentValue(assignment.value));
        }
        return command.assignments.length > 0 ? this.lastSubstitutionStatus : 0;
      } finally {
        this.settleRedirections(applied, fds);
      }
    }

    const restore: (() => void)[] = [];
    try {
      for (const assignment of command.assignments) {
        const value = await this.expandAssignmentValue(assignment.value);
        const previous = this.variables.get(assignment.name);
        restore.push(() => {
          if (previous) this.variables.set(assignment.name, previous);
          else this.variables.delete(assignment.name);
        });
        this.assign(assignment.name, value, { exported: true });
      }
      if (this.options.xtrace) io.stderr.write(encodeText(`+ ${argv.join(" ")}\n`));
      return await this.dispatch(argv, io);
    } finally {
      // A variable prefix is scoped to one command, except on a special
      // builtin, where POSIX says the assignment persists.
      if (!SPECIAL_BUILTINS.has(argv[0])) for (const undo of restore.reverse()) undo();
      this.settleRedirections(applied, fds);
    }
  }

  private async dispatch(argv: readonly string[], io: CommandIo): Promise<number> {
    const name = argv[0];
    const context: CommandContext = Object.freeze({
      argv,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      shell: this,
    });
    // POSIX search order: special builtins, then functions, then regular
    // builtins, then utilities. Nothing after that exists in this engine.
    const special = SPECIAL_BUILTINS.get(name);
    if (special) return this.guard(name, io, () => special(context));
    const fn = this.functions.get(name);
    if (fn) return this.callFunction(fn, argv, io);
    const builtin = BUILTINS.get(name);
    if (builtin) return this.guard(name, io, () => builtin(context));
    const utility = UTILITIES.get(name);
    if (utility) return this.guard(name, io, () => utility(context));
    io.stderr.write(encodeText(`airship-sh: ${name}: command not found\n`));
    return AIRSHIP_SH_STATUS.commandNotFound;
  }

  private async guard(name: string, io: CommandIo, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ShellCommandError) {
        io.stderr.write(encodeText(`${name}: ${error.message}\n`));
        return error.status;
      }
      throw error;
    }
  }

  private async callFunction(body: Command, argv: readonly string[], io: CommandIo): Promise<number> {
    if (this.depth >= AIRSHIP_SH_MAX_DEPTH) {
      throw new ShellFatalError("budget", `airship-sh: exceeded ${AIRSHIP_SH_MAX_DEPTH} levels of shell nesting.`);
    }
    const savedParameters = this.parameters;
    this.parameters = [...argv.slice(1)];
    this.depth += 1;
    this.localFrames.push(new Map());
    try {
      return await this.executeCommand(body, this.descriptorsFor(io));
    } catch (error) {
      if (error instanceof ReturnSignal) return error.status;
      throw error;
    } finally {
      const frame = this.localFrames.pop();
      for (const [name, previous] of frame ?? []) {
        if (previous) this.variables.set(name, previous);
        else this.variables.delete(name);
      }
      this.depth -= 1;
      this.parameters = savedParameters;
    }
  }

  private handleLoopSignal(error: unknown): "break" | "continue" | "rethrow" {
    if (!(error instanceof LoopSignal)) return "rethrow";
    if (error.count > 1) {
      error.count -= 1;
      throw error;
    }
    return error.kind;
  }

  private async withCondition<T>(active: boolean, run: () => Promise<T>): Promise<T> {
    if (!active) return run();
    this.conditionDepth += 1;
    try {
      return await run();
    } finally {
      this.conditionDepth -= 1;
    }
  }

  private async runSubshell(run: (child: Interpreter) => Promise<number>): Promise<number> {
    if (this.depth >= AIRSHIP_SH_MAX_DEPTH) {
      throw new ShellFatalError("budget", `airship-sh: exceeded ${AIRSHIP_SH_MAX_DEPTH} levels of shell nesting.`);
    }
    const child = this.fork();
    const savedCwd = this.fs.cwd;
    try {
      return await run(child);
    } catch (error) {
      // A subshell's `exit` ends the subshell, not the enclosing script.
      if (error instanceof ExitSignal) return error.status;
      throw error;
    } finally {
      this.fs.changeDirectory(savedCwd);
    }
  }

  /**
   * A subshell shares the filesystem — a forked process would too — but gets
   * its own copy of variables, functions, aliases, options, and positional
   * parameters, so changes inside it are discarded when it ends.
   */
  private fork(): Interpreter {
    const child = new Interpreter({
      fs: this.fs,
      budget: this.budget,
      stdout: this.rootIo.stdout,
      stderr: this.rootIo.stderr,
      stdin: this.rootIo.stdin,
      positional: this.parameters,
      scriptName: this.scriptName,
      runId: this.runId,
    });
    child.variables.clear();
    for (const [name, variable] of this.variables) child.variables.set(name, { ...variable });
    for (const [name, body] of this.functions) child.functions.set(name, body);
    for (const [name, value] of this.aliases) child.aliases.set(name, value);
    for (const [name, value] of this.traps) child.traps.set(name, value);
    Object.assign(child.options, this.options);
    child.status = this.status;
    child.depth = this.depth + 1;
    child.activeIo = this.activeIo;
    return child;
  }

  // --- expansion support --------------------------------------------------

  private expansionHost(): ExpansionHost {
    const shell = this;
    return {
      fs: this.fs,
      get noglob(): boolean {
        return shell.options.noglob;
      },
      get nounset(): boolean {
        return shell.options.nounset;
      },
      lookup: (name) => this.lookup(name),
      assign: (name, value) => this.assign(name, value),
      positional: () => this.positional(),
      special: (name) => this.specialParameter(name),
      home: () => this.lookup("HOME") ?? this.fs.root,
      substitute: (script) => this.substitute(script),
      charge: (steps) => this.charge(steps),
    };
  }

  private specialParameter(name: string): string | undefined {
    switch (name) {
      case "?":
        return String(this.status);
      case "#":
        return String(this.parameters.length);
      case "0":
        return this.scriptName;
      case "$":
        // There is no operating-system process here. `$$` is a stable per-run
        // integer so `tmp.$$` still yields a unique name; it is not a PID.
        return String(this.runId);
      case "!":
        // No background jobs exist, so there is no most-recent job id.
        return "";
      case "-":
        return currentOptionFlags(this.options);
      default:
        return undefined;
    }
  }

  private async substitute(script: string): Promise<string> {
    const buffer = new PipeBuffer();
    const io: CommandIo = { stdin: this.activeIo.stdin, stdout: buffer, stderr: this.activeIo.stderr };
    const status = await this.runSubshell(async (child) => {
      child.activeIo = io;
      return child.executeList(parseShellScript(script).body, child.descriptorsFor(io));
    });
    this.lastSubstitutionStatus = status;
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer.bytes()).replace(/\n+$/u, "");
  }

  private async expandAssignmentValue(word: Word): Promise<string> {
    return expandToString(word, this.expansionHost());
  }

  /**
   * Aliases are substituted when a command name is resolved, not while
   * parsing. An alias can therefore supply a command and arguments but can
   * never introduce syntax — a deliberately narrower contract than an
   * interactive shell's, and one that is stated rather than implied.
   */
  private async expandAliases(argv: readonly string[]): Promise<string[]> {
    let current = [...argv];
    const seen = new Set<string>();
    for (;;) {
      const name = current[0];
      if (name === undefined) return current;
      const alias = this.aliases.get(name);
      if (alias === undefined || seen.has(name)) return current;
      seen.add(name);
      this.charge();
      current = [...(await this.aliasWords(alias)), ...current.slice(1)];
    }
  }

  private async aliasWords(alias: string): Promise<string[]> {
    const words: string[] = [];
    for (const token of tokenize(alias)) {
      if (token.kind === "eof" || token.kind === "newline") break;
      if (token.kind !== "word") {
        throw new ShellCommandError(`alias contains shell syntax airship-sh cannot substitute: ${alias}`, 2);
      }
      words.push(...(await expandToFields(token.word, this.expansionHost())));
    }
    return words;
  }

  // --- redirection --------------------------------------------------------

  private descriptorsFor(io: CommandIo): Descriptors {
    return new Map<number, Descriptor>([
      [0, { direction: "read", reader: io.stdin }],
      [1, { direction: "write", sink: io.stdout }],
      [2, { direction: "write", sink: io.stderr }],
    ]);
  }

  private async applyRedirections(
    redirections: readonly Redirection[],
    fds: Descriptors,
  ): Promise<Readonly<{ fds: Descriptors; sinks: readonly FileSink[]; close: () => void }>> {
    if (redirections.length === 0) {
      return Object.freeze({ fds, sinks: Object.freeze([]), close: () => {} });
    }
    const next: Descriptors = new Map(fds);
    const sinks: FileSink[] = [];
    for (const redirection of redirections) {
      this.charge();
      if (redirection.operator === "<<") {
        const body = redirection.here ? await expandToString(redirection.here, this.expansionHost()) : "";
        next.set(redirection.fd, { direction: "read", reader: ByteReader.fromText(body) });
        continue;
      }
      const fields = await expandToFields(redirection.target ?? [], this.expansionHost());
      if (fields.length !== 1) throw new ShellCommandError("ambiguous redirect", 1);
      const target = fields[0];
      if (redirection.operator === ">&" || redirection.operator === "<&") {
        if (target === "-") {
          next.set(redirection.fd, { direction: "write", sink: NULL_SINK });
          continue;
        }
        const source = next.get(Number.parseInt(target, 10));
        if (!source) throw new ShellCommandError(`${target}: bad file descriptor`, 1);
        next.set(redirection.fd, source);
        continue;
      }
      if (redirection.operator === "<") {
        next.set(redirection.fd, { direction: "read", reader: this.openReader(target) });
        continue;
      }
      if (target === "/dev/null") {
        next.set(redirection.fd, { direction: "write", sink: NULL_SINK });
        continue;
      }
      if (redirection.operator === "<>") {
        const path = this.fs.resolve(target);
        if (!this.fs.isFile(path)) this.fs.writeFile(path, new Uint8Array());
        next.set(0, { direction: "read", reader: new ByteReader(this.fs.readFile(path)) });
        const sink = new FileSink(this.fs, path, true);
        sinks.push(sink);
        next.set(1, { direction: "write", sink });
        continue;
      }
      const sink = new FileSink(this.fs, this.fs.resolve(target), redirection.operator === ">>");
      sinks.push(sink);
      next.set(redirection.fd, { direction: "write", sink });
    }
    return Object.freeze({
      fds: next,
      sinks: Object.freeze(sinks),
      close: () => {
        for (const sink of sinks) sink.close();
      },
    });
  }

  /**
   * Closes a command's redirections, or — after `exec` with no command —
   * promotes them into the enclosing descriptor set so later commands inherit
   * them. The enclosing map is mutated in place because it is the same object
   * every command in the list already holds.
   */
  private settleRedirections(
    applied: Readonly<{ fds: Descriptors; sinks: readonly FileSink[]; close: () => void }>,
    enclosing: Descriptors,
  ): void {
    if (this.persistNextRedirections) {
      this.persistNextRedirections = false;
      for (const [fd, descriptor] of applied.fds) enclosing.set(fd, descriptor);
      for (const sink of applied.sinks) this.persistentSinks.add(sink);
    }
    applied.close();
    this.flushPersistentSinks();
  }

  private openReader(target: string): ByteReader {
    if (target === "/dev/null") return ByteReader.empty();
    return new ByteReader(this.fs.readFile(this.fs.resolve(target)));
  }

  private flushPersistentSinks(): void {
    for (const sink of this.persistentSinks) sink.close();
  }
}

function readerFor(fds: Descriptors, fd: number): ByteReader {
  const descriptor = fds.get(fd);
  return descriptor?.direction === "read" ? descriptor.reader : ByteReader.empty();
}

function sinkFor(fds: Descriptors, fd: number, fallback: ByteSink): ByteSink {
  const descriptor = fds.get(fd);
  return descriptor?.direction === "write" ? descriptor.sink : fallback;
}

function ioFor(fds: Descriptors, root: CommandIo): CommandIo {
  return Object.freeze({
    stdin: readerFor(fds, 0),
    stdout: sinkFor(fds, 1, root.stdout),
    stderr: sinkFor(fds, 2, root.stderr),
  });
}

export function currentOptionFlags(options: ShellOptions): string {
  let flags = "";
  if (options.errexit) flags += "e";
  if (options.noglob) flags += "f";
  if (options.nounset) flags += "u";
  if (options.xtrace) flags += "x";
  return flags;
}
