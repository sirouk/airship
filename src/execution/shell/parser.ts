import type {
  AndOrLink,
  AndOrList,
  Assignment,
  CaseItem,
  Command,
  CommandList,
  IfClause,
  Pipeline,
  Redirection,
  RedirectionOperator,
  ShellProgram,
  Word,
} from "./ast";
import { ShellParseError } from "./errors";
import { tokenize, type OperatorText, type Token } from "./lexer";

const RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "in",
  "case",
  "esac",
  "{",
  "}",
  "!",
]);

const REDIRECTION_OPERATORS = new Set<OperatorText>(["<", ">", ">>", "<&", ">&", "<>", ">|", "<<"]);

export function parseShellScript(source: string): ShellProgram {
  return Object.freeze({ body: new Parser(tokenize(source)).parseProgram() });
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseProgram(): CommandList {
    const body = this.parseCommandList(new Set());
    if (!this.at("eof")) throw this.error(`unexpected ${describe(this.peek())}`);
    return body;
  }

  private parseCommandList(stops: ReadonlySet<string>): CommandList {
    const items: AndOrList[] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.at("eof") || this.atStop(stops)) break;
      items.push(this.parseAndOr());
      let separated = false;
      for (;;) {
        if (this.atOperator(";")) {
          this.advance();
          separated = true;
          continue;
        }
        if (this.atOperator("&")) {
          throw this.error("background execution (&) and job control are not implemented by airship-sh");
        }
        if (this.at("newline")) {
          this.advance();
          separated = true;
          continue;
        }
        break;
      }
      if (!separated) break;
    }
    return Object.freeze({ items: Object.freeze(items) });
  }

  private parseRequiredList(stops: ReadonlySet<string>, context: string): CommandList {
    const list = this.parseCommandList(stops);
    if (list.items.length === 0) throw this.error(`${context} requires at least one command`);
    return list;
  }

  private parseAndOr(): AndOrList {
    const first = this.parsePipeline();
    const rest: AndOrLink[] = [];
    for (;;) {
      const operator = this.atOperator("&&") ? "&&" : this.atOperator("||") ? "||" : undefined;
      if (!operator) break;
      this.advance();
      this.skipLinebreaks();
      rest.push(Object.freeze({ operator, pipeline: this.parsePipeline() }));
    }
    return Object.freeze({ first, rest: Object.freeze(rest) });
  }

  private parsePipeline(): Pipeline {
    let negated = false;
    while (this.atReserved("!")) {
      this.advance();
      negated = !negated;
    }
    const commands: Command[] = [this.parseCommand()];
    while (this.atOperator("|")) {
      this.advance();
      this.skipLinebreaks();
      commands.push(this.parseCommand());
    }
    return Object.freeze({ negated, commands: Object.freeze(commands) });
  }

  private parseCommand(): Command {
    if (this.atReserved("if")) return this.parseIf();
    if (this.atReserved("while")) return this.parseWhile(false);
    if (this.atReserved("until")) return this.parseWhile(true);
    if (this.atReserved("for")) return this.parseFor();
    if (this.atReserved("case")) return this.parseCase();
    if (this.atReserved("{")) return this.parseGroup();
    if (this.atOperator("(")) return this.parseSubshell();
    const token = this.peek();
    if (token.kind === "word" && token.literalOnly && token.text === "function") {
      throw this.error("airship-sh implements POSIX function definitions (`name() { ... }`); the `function` keyword is a bash extension");
    }
    return this.parseSimpleCommand();
  }

  private parseIf(): Command {
    this.advance();
    const clauses: IfClause[] = [];
    const condition = this.parseRequiredList(new Set(["then"]), "`if`");
    this.expectReserved("then");
    clauses.push(Object.freeze({ condition, body: this.parseRequiredList(new Set(["elif", "else", "fi"]), "`then`") }));
    let otherwise: CommandList | undefined;
    for (;;) {
      if (this.atReserved("elif")) {
        this.advance();
        const elifCondition = this.parseRequiredList(new Set(["then"]), "`elif`");
        this.expectReserved("then");
        clauses.push(Object.freeze({
          condition: elifCondition,
          body: this.parseRequiredList(new Set(["elif", "else", "fi"]), "`then`"),
        }));
        continue;
      }
      if (this.atReserved("else")) {
        this.advance();
        otherwise = this.parseRequiredList(new Set(["fi"]), "`else`");
      }
      break;
    }
    this.expectReserved("fi");
    return Object.freeze({
      kind: "if",
      clauses: Object.freeze(clauses),
      ...(otherwise ? { otherwise } : {}),
      redirections: this.parseRedirectionList(),
    });
  }

  private parseWhile(invert: boolean): Command {
    this.advance();
    const condition = this.parseRequiredList(new Set(["do"]), invert ? "`until`" : "`while`");
    this.expectReserved("do");
    const body = this.parseRequiredList(new Set(["done"]), "`do`");
    this.expectReserved("done");
    return Object.freeze({ kind: "while", invert, condition, body, redirections: this.parseRedirectionList() });
  }

  private parseFor(): Command {
    this.advance();
    const nameToken = this.peek();
    if (nameToken.kind !== "word" || !nameToken.literalOnly || !isName(nameToken.text)) {
      throw this.error("`for` requires a variable name");
    }
    this.advance();
    let words: readonly Word[] | undefined;
    if (this.atReserved("in")) {
      this.advance();
      const collected: Word[] = [];
      while (this.peek().kind === "word") {
        const token = this.peek();
        if (token.kind === "word" && token.literalOnly && (token.text === "do" || token.text === "done")) break;
        collected.push(token.kind === "word" ? token.word : Object.freeze([]));
        this.advance();
      }
      words = Object.freeze(collected);
      if (this.atOperator(";")) this.advance();
    } else if (this.atOperator(";")) {
      this.advance();
    }
    this.skipLinebreaks();
    this.expectReserved("do");
    const body = this.parseRequiredList(new Set(["done"]), "`do`");
    this.expectReserved("done");
    return Object.freeze({
      kind: "for",
      name: nameToken.text,
      ...(words ? { words } : {}),
      body,
      redirections: this.parseRedirectionList(),
    });
  }

  private parseCase(): Command {
    this.advance();
    const subject = this.peek();
    if (subject.kind !== "word") throw this.error("`case` requires a word");
    this.advance();
    this.skipLinebreaks();
    this.expectReserved("in");
    const items: CaseItem[] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.atReserved("esac")) break;
      if (this.atOperator("(")) this.advance();
      const patterns: Word[] = [];
      for (;;) {
        const token = this.peek();
        if (token.kind !== "word") throw this.error("`case` requires a pattern before `)`");
        patterns.push(token.word);
        this.advance();
        if (this.atOperator("|")) {
          this.advance();
          continue;
        }
        break;
      }
      if (!this.atOperator(")")) throw this.error("`case` pattern must be followed by `)`");
      this.advance();
      const body = this.parseCommandList(new Set([";;", "esac"]));
      items.push(Object.freeze({ patterns: Object.freeze(patterns), body }));
      this.skipLinebreaks();
      if (this.atOperator(";;")) {
        this.advance();
        continue;
      }
      break;
    }
    this.expectReserved("esac");
    return Object.freeze({
      kind: "case",
      word: subject.kind === "word" ? subject.word : Object.freeze([]),
      items: Object.freeze(items),
      redirections: this.parseRedirectionList(),
    });
  }

  private parseGroup(): Command {
    this.advance();
    const body = this.parseRequiredList(new Set(["}"]), "`{ }`");
    this.expectReserved("}");
    return Object.freeze({ kind: "group", body, redirections: this.parseRedirectionList() });
  }

  private parseSubshell(): Command {
    this.advance();
    const body = this.parseRequiredList(new Set([")"]), "`( )`");
    if (!this.atOperator(")")) throw this.error("expected `)` to close a subshell");
    this.advance();
    return Object.freeze({ kind: "subshell", body, redirections: this.parseRedirectionList() });
  }

  private parseSimpleCommand(): Command {
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirections: Redirection[] = [];
    for (;;) {
      if (this.atRedirection()) {
        redirections.push(this.parseRedirection());
        continue;
      }
      const token = this.peek();
      if (token.kind !== "word") break;
      if (words.length === 0 && token.literalOnly && isName(token.text) && this.isFunctionDefinition()) {
        return this.parseFunctionDefinition(token.text);
      }
      const assignment = words.length === 0 ? splitAssignment(token.word) : undefined;
      this.advance();
      if (assignment) {
        assignments.push(assignment);
        continue;
      }
      words.push(token.word);
    }
    if (assignments.length === 0 && words.length === 0 && redirections.length === 0) {
      throw this.error(`expected a command but found ${describe(this.peek())}`);
    }
    return Object.freeze({
      kind: "simple",
      assignments: Object.freeze(assignments),
      words: Object.freeze(words),
      redirections: Object.freeze(redirections),
    });
  }

  private isFunctionDefinition(): boolean {
    const open = this.tokens[this.position + 1];
    const close = this.tokens[this.position + 2];
    return open?.kind === "operator" && open.text === "(" && close?.kind === "operator" && close.text === ")";
  }

  private parseFunctionDefinition(name: string): Command {
    this.advance();
    this.advance();
    this.advance();
    this.skipLinebreaks();
    const body = this.parseCommand();
    if (body.kind === "function") throw this.error("a function body cannot be another function definition");
    return Object.freeze({ kind: "function", name, body });
  }

  private parseRedirectionList(): readonly Redirection[] {
    const redirections: Redirection[] = [];
    while (this.atRedirection()) redirections.push(this.parseRedirection());
    return Object.freeze(redirections);
  }

  private atRedirection(): boolean {
    const token = this.peek();
    if (token.kind === "io-number") {
      const operator = this.tokens[this.position + 1];
      return operator?.kind === "operator" && REDIRECTION_OPERATORS.has(operator.text);
    }
    return token.kind === "operator" && REDIRECTION_OPERATORS.has(token.text);
  }

  private parseRedirection(): Redirection {
    const first = this.peek();
    let fd: number | undefined;
    if (first.kind === "io-number") {
      fd = first.value;
      this.advance();
    }
    const operatorToken = this.peek();
    if (operatorToken.kind !== "operator") throw this.error("expected a redirection operator");
    const operator = operatorToken.text as RedirectionOperator;
    this.advance();
    if (operator === "<<") {
      if (!operatorToken.heredoc) throw this.error("here-document body was not collected");
      return Object.freeze({ fd: fd ?? 0, operator, here: operatorToken.heredoc.body });
    }
    const target = this.peek();
    if (target.kind !== "word") throw this.error(`redirection ${operator} requires a target`);
    this.advance();
    if (operator === ">&" || operator === "<&") {
      if (!target.literalOnly || !/^([0-9]+|-)$/u.test(target.text)) {
        throw this.error(
          `${operator} requires a file descriptor number or \`-\`; airship-sh does not implement the bash \`>&file\` extension`,
        );
      }
    }
    return Object.freeze({ fd: fd ?? defaultFd(operator), operator, target: target.word });
  }

  private atStop(stops: ReadonlySet<string>): boolean {
    const token = this.peek();
    if (token.kind === "operator") return stops.has(token.text);
    return token.kind === "word" && token.literalOnly && RESERVED_WORDS.has(token.text) && stops.has(token.text);
  }

  private atReserved(word: string): boolean {
    const token = this.peek();
    return token.kind === "word" && token.literalOnly && token.text === word && RESERVED_WORDS.has(word);
  }

  private expectReserved(word: string): void {
    if (!this.atReserved(word)) throw this.error(`expected \`${word}\` but found ${describe(this.peek())}`);
    this.advance();
  }

  private atOperator(text: OperatorText): boolean {
    const token = this.peek();
    return token.kind === "operator" && token.text === text;
  }

  private at(kind: Token["kind"]): boolean {
    return this.peek().kind === kind;
  }

  private skipLinebreaks(): void {
    while (this.at("newline")) this.advance();
  }

  private peek(): Token {
    return this.tokens[this.position] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const token = this.peek();
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private error(message: string): ShellParseError {
    const token = this.peek();
    return new ShellParseError(message, token.line, token.column);
  }
}

function defaultFd(operator: RedirectionOperator): number {
  return operator === "<" || operator === "<>" || operator === "<&" || operator === "<<" ? 0 : 1;
}

function isName(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(text);
}

/**
 * `NAME=value` is an assignment only when the `NAME=` prefix itself is
 * unquoted literal text. `"foo"=bar` is an ordinary command word, and treating
 * it as an assignment is how a shell silently swallows an intended argument.
 */
function splitAssignment(word: Word): Assignment | undefined {
  const first = word[0];
  if (!first || first.kind !== "literal" || first.quoted) return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(first.text);
  if (!match) return undefined;
  const remainder = first.text.slice(match[0].length);
  const value: Word = [
    ...(remainder ? [Object.freeze({ kind: "literal" as const, text: remainder, quoted: false })] : []),
    ...word.slice(1),
  ];
  return Object.freeze({ name: match[1], value: Object.freeze(value) });
}

function describe(token: Token): string {
  switch (token.kind) {
    case "word":
      return `\`${token.text}\``;
    case "operator":
      return `\`${token.text}\``;
    case "io-number":
      return `\`${token.value}\``;
    case "newline":
      return "end of line";
    case "eof":
      return "end of input";
  }
}
