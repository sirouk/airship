import type { ParameterOperator, Word, WordPart } from "./ast";
import { ShellParseError } from "./errors";

export type OperatorText =
  | "&&"
  | "||"
  | ";;"
  | "<<"
  | ">>"
  | "<&"
  | ">&"
  | "<>"
  | ">|"
  | ";"
  | "&"
  | "|"
  | "("
  | ")"
  | "<"
  | ">";

/**
 * A here-document body is discovered after the line that declares it, so the
 * record the operator token carries is filled in later by the same tokenizer
 * pass. Tokenization always completes before parsing begins, so a parser only
 * ever observes a populated body.
 */
export type HeredocRecord = {
  readonly stripTabs: boolean;
  readonly delimiter: string;
  /** A quoted delimiter suppresses expansion of the body, per POSIX. */
  readonly quoted: boolean;
  body: Word;
};

export type Token =
  | Readonly<{
      kind: "word";
      word: Word;
      /** Literal text; meaningful only when `literalOnly` is true. */
      text: string;
      /** False as soon as any quoting or expansion appears, so a quoted `if` is not a keyword. */
      literalOnly: boolean;
      line: number;
      column: number;
    }>
  | Readonly<{ kind: "operator"; text: OperatorText; heredoc?: HeredocRecord; line: number; column: number }>
  | Readonly<{ kind: "io-number"; value: number; line: number; column: number }>
  | Readonly<{ kind: "newline"; line: number; column: number }>
  | Readonly<{ kind: "eof"; line: number; column: number }>;

const OPERATOR_START = new Set(["|", "&", ";", "<", ">", "(", ")"]);
const PARAMETER_SPECIALS = new Set(["?", "$", "!", "#", "*", "@", "-", "0"]);

export function tokenize(source: string): readonly Token[] {
  return new Lexer(source).tokenize();
}

/** Lexes one standalone word fragment, used for `${...}` arguments and `$(( ))` sources. */
export function lexWordFragment(source: string, quoted: boolean, line: number, column: number): Word {
  const lexer = new Lexer(source, line, column);
  return lexer.readWordParts(() => false, quoted);
}

class Lexer {
  private index = 0;
  private readonly tokens: Token[] = [];
  private readonly pendingHeredocs: HeredocRecord[] = [];

  constructor(private readonly source: string, private line = 1, private column = 1) {}

  tokenize(): readonly Token[] {
    for (;;) {
      this.skipBlanks();
      if (this.atEnd()) break;
      const char = this.peek();
      if (char === "#") {
        while (!this.atEnd() && this.peek() !== "\n") this.next();
        continue;
      }
      if (char === "\n") {
        const { line, column } = this;
        this.next();
        this.tokens.push(Object.freeze({ kind: "newline", line, column }));
        this.readPendingHeredocs();
        continue;
      }
      if (char === "\\" && this.peek(1) === "\n") {
        this.next();
        this.next();
        continue;
      }
      if (OPERATOR_START.has(char)) {
        this.readOperator();
        continue;
      }
      this.readWordToken();
    }
    if (this.pendingHeredocs.length > 0) {
      throw this.error(`unterminated here-document; expected the delimiter ${this.pendingHeredocs[0].delimiter}`);
    }
    this.tokens.push(Object.freeze({ kind: "eof", line: this.line, column: this.column }));
    return Object.freeze(this.tokens);
  }

  readWordParts(terminate: (char: string) => boolean, quotedContext = false): Word {
    const parts: WordPart[] = [];
    const push = (part: WordPart): void => {
      const last = parts[parts.length - 1];
      if (part.kind === "literal" && last?.kind === "literal" && last.quoted === part.quoted) {
        parts[parts.length - 1] = Object.freeze({ kind: "literal", text: last.text + part.text, quoted: last.quoted });
        return;
      }
      parts.push(part);
    };
    if (!quotedContext && this.peek() === "~") this.readTilde(push);
    while (!this.atEnd()) {
      const char = this.peek();
      if (terminate(char)) break;
      if (char === "'" && !quotedContext) {
        this.next();
        push(Object.freeze({ kind: "literal", text: this.readSingleQuoted(), quoted: true }));
        continue;
      }
      if (char === '"' && !quotedContext) {
        this.next();
        // The empty part is load-bearing: `""` must survive as a real empty
        // field, and a word with no parts at all would be removed entirely.
        push(Object.freeze({ kind: "literal", text: "", quoted: true }));
        this.readQuotedBody(push, '"');
        continue;
      }
      if (char === "\\") {
        if (this.peek(1) === "\n") {
          this.next();
          this.next();
          continue;
        }
        this.next();
        if (this.atEnd()) throw this.error("a backslash must escape a character");
        push(Object.freeze({ kind: "literal", text: this.next(), quoted: true }));
        continue;
      }
      if (char === "$") {
        push(this.readDollar(quotedContext));
        continue;
      }
      if (char === "`") {
        this.next();
        push(Object.freeze({ kind: "command", script: this.readBackquoted(), quoted: quotedContext }));
        continue;
      }
      push(Object.freeze({ kind: "literal", text: this.next(), quoted: quotedContext }));
    }
    return Object.freeze(parts);
  }

  private readWordToken(): void {
    const { line, column } = this;
    const word = this.readWordParts((char) => char === "\n" || char === " " || char === "\t" || OPERATOR_START.has(char));
    const literalOnly = word.every((part) => part.kind === "literal" && !part.quoted);
    const text = word.map((part) => (part.kind === "literal" ? part.text : "")).join("");
    if (literalOnly && /^[0-9]+$/u.test(text) && (this.peek() === "<" || this.peek() === ">")) {
      this.tokens.push(Object.freeze({ kind: "io-number", value: Number.parseInt(text, 10), line, column }));
      return;
    }
    this.tokens.push(Object.freeze({ kind: "word", word, text, literalOnly, line, column }));
  }

  private readTilde(push: (part: WordPart) => void): void {
    let offset = 1;
    let user = "";
    for (;;) {
      const char = this.peek(offset);
      if (char === "" || char === "/" || char === " " || char === "\t" || char === "\n" || OPERATOR_START.has(char)) break;
      if (!/^[A-Za-z0-9._-]$/u.test(char)) return;
      user += char;
      offset += 1;
    }
    for (let step = 0; step < offset; step += 1) this.next();
    push(Object.freeze({ kind: "tilde", user }));
  }

  private readSingleQuoted(): string {
    let text = "";
    for (;;) {
      if (this.atEnd()) throw this.error("unterminated single quote");
      const char = this.next();
      if (char === "'") return text;
      text += char;
    }
  }

  /**
   * Double-quoted content and unquoted here-document bodies share one rule set:
   * only `$`, backquote, backslash, and a line continuation are special. Passing
   * `undefined` as the terminator lexes to end of input for a here-document.
   */
  private readQuotedBody(push: (part: WordPart) => void, terminator: '"' | undefined): void {
    for (;;) {
      if (this.atEnd()) {
        if (terminator === undefined) return;
        throw this.error("unterminated double quote");
      }
      const char = this.peek();
      if (char === terminator) {
        this.next();
        return;
      }
      if (char === "\\") {
        const escaped = this.peek(1);
        if (escaped === "\n") {
          this.next();
          this.next();
          continue;
        }
        if (escaped === "$" || escaped === "`" || escaped === "\\" || (terminator === '"' && escaped === '"')) {
          this.next();
          push(Object.freeze({ kind: "literal", text: this.next(), quoted: true }));
          continue;
        }
        push(Object.freeze({ kind: "literal", text: this.next(), quoted: true }));
        continue;
      }
      if (char === "$") {
        push(this.readDollar(true));
        continue;
      }
      if (char === "`") {
        this.next();
        push(Object.freeze({ kind: "command", script: this.readBackquoted(), quoted: true }));
        continue;
      }
      push(Object.freeze({ kind: "literal", text: this.next(), quoted: true }));
    }
  }

  private readDollar(quoted: boolean): WordPart {
    const { line, column } = this;
    this.next();
    const char = this.peek();
    if (char === "(") {
      if (this.peek(1) === "(") {
        const arithmetic = this.tryReadArithmetic(quoted, line, column);
        if (arithmetic) return arithmetic;
      }
      this.next();
      return Object.freeze({ kind: "command", script: this.readBalanced("(", ")"), quoted });
    }
    if (char === "{") {
      this.next();
      return this.readBracedParameter(this.readBalanced("{", "}"), quoted, line, column);
    }
    if (/^[A-Za-z_]$/u.test(char)) {
      let name = "";
      while (/^[A-Za-z0-9_]$/u.test(this.peek())) name += this.next();
      return Object.freeze({ kind: "parameter", name, operator: "none", colon: false, length: false, quoted });
    }
    if (/^[0-9]$/u.test(char)) {
      return Object.freeze({ kind: "parameter", name: this.next(), operator: "none", colon: false, length: false, quoted });
    }
    if (PARAMETER_SPECIALS.has(char)) {
      return Object.freeze({ kind: "parameter", name: this.next(), operator: "none", colon: false, length: false, quoted });
    }
    return Object.freeze({ kind: "literal", text: "$", quoted });
  }

  /**
   * `$((` is genuinely ambiguous with `$(` followed by a subshell. It is
   * arithmetic only when the balanced scan ends on two adjacent closing
   * parentheses; otherwise the position is restored and the text is a command
   * substitution, which is what a POSIX shell does with `$( (a) )`.
   */
  private tryReadArithmetic(quoted: boolean, line: number, column: number): WordPart | undefined {
    const startIndex = this.index;
    const startLine = this.line;
    const startColumn = this.column;
    this.next();
    this.next();
    let depth = 1;
    let source = "";
    while (!this.atEnd()) {
      const char = this.peek();
      if (char === "'" || char === '"') {
        source += this.next();
        source += this.readRawQuoted(char);
        continue;
      }
      if (char === "\\") {
        source += this.next();
        if (!this.atEnd()) source += this.next();
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          if (this.peek(1) !== ")") break;
          this.next();
          this.next();
          return Object.freeze({
            kind: "arithmetic",
            source: lexWordFragment(source, quoted, line, column),
            quoted,
          });
        }
      }
      source += this.next();
    }
    this.index = startIndex;
    this.line = startLine;
    this.column = startColumn;
    return undefined;
  }

  private readBracedParameter(content: string, quoted: boolean, line: number, column: number): WordPart {
    if (content.length === 0) throw new ShellParseError("empty ${} expansion", line, column);
    let rest = content;
    let length = false;
    if (rest.startsWith("#") && rest.length > 1) {
      length = true;
      rest = rest.slice(1);
    }
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#*@\-])/u.exec(rest);
    if (!nameMatch) throw new ShellParseError(`unsupported parameter expansion: \${${content}}`, line, column);
    const name = nameMatch[1];
    rest = rest.slice(name.length);
    if (length) {
      if (rest.length > 0) {
        throw new ShellParseError(`\${#${name}} takes no operator; \${${content}} is not supported`, line, column);
      }
      return Object.freeze({ kind: "parameter", name, operator: "none", colon: false, length: true, quoted });
    }
    if (rest.length === 0) {
      return Object.freeze({ kind: "parameter", name, operator: "none", colon: false, length: false, quoted });
    }
    const parsed = parseParameterOperator(rest);
    if (!parsed) {
      throw new ShellParseError(
        `unsupported parameter expansion operator in \${${content}}; airship-sh implements :- := :? :+ - = ? + # ## % %% and \${#name}`,
        line,
        column,
      );
    }
    // `${x%pattern}` is a pattern, not text: enclosing double quotes do not
    // quote it, so `"${p%.*}"` must still trim by a glob. The `:-` family is
    // the opposite — its word inherits the surrounding quoting.
    const isPattern = parsed.operator.startsWith("remove-");
    return Object.freeze({
      kind: "parameter",
      name,
      operator: parsed.operator,
      colon: parsed.colon,
      length: false,
      argument: lexWordFragment(rest.slice(parsed.consumed), isPattern ? false : quoted, line, column),
      quoted,
    });
  }

  private readBackquoted(): string {
    let script = "";
    for (;;) {
      if (this.atEnd()) throw this.error("unterminated backquote command substitution");
      const char = this.next();
      if (char === "`") return script;
      if (char === "\\") {
        const escaped = this.next();
        // Inside backquotes only these three keep their backslash meaning.
        script += escaped === "$" || escaped === "`" || escaped === "\\" ? escaped : `\\${escaped}`;
        continue;
      }
      script += char;
    }
  }

  /** Balanced scan that respects quoting and nested substitutions. */
  private readBalanced(open: string, close: string): string {
    let depth = 1;
    let text = "";
    for (;;) {
      if (this.atEnd()) throw this.error(`unterminated ${open}${close} expansion`);
      const char = this.peek();
      if (char === "'" || char === '"') {
        text += this.next();
        text += this.readRawQuoted(char);
        continue;
      }
      if (char === "\\") {
        text += this.next();
        if (!this.atEnd()) text += this.next();
        continue;
      }
      if (char === open) depth += 1;
      if (char === close) {
        depth -= 1;
        if (depth === 0) {
          this.next();
          return text;
        }
      }
      text += this.next();
    }
  }

  /** Copies a quoted region verbatim, including its terminator. */
  private readRawQuoted(quote: string): string {
    let text = "";
    for (;;) {
      if (this.atEnd()) throw this.error(`unterminated ${quote} quote`);
      const char = this.next();
      text += char;
      if (char === "\\" && quote === '"' && !this.atEnd()) {
        text += this.next();
        continue;
      }
      if (char === quote) return text;
    }
  }

  private readOperator(): void {
    const { line, column } = this;
    const three = this.source.slice(this.index, this.index + 3);
    if (three === "<<-") {
      this.next();
      this.next();
      this.next();
      this.tokens.push(Object.freeze({ kind: "operator", text: "<<", heredoc: this.declareHeredoc(true), line, column }));
      return;
    }
    const two = this.source.slice(this.index, this.index + 2);
    if (two === "<<") {
      this.next();
      this.next();
      this.tokens.push(Object.freeze({ kind: "operator", text: "<<", heredoc: this.declareHeredoc(false), line, column }));
      return;
    }
    if (two === "&&" || two === "||" || two === ";;" || two === ">>" || two === "<&" || two === ">&" || two === "<>" || two === ">|") {
      this.next();
      this.next();
      this.tokens.push(Object.freeze({ kind: "operator", text: two, line, column }));
      return;
    }
    const one = this.next();
    if (one !== ";" && one !== "&" && one !== "|" && one !== "(" && one !== ")" && one !== "<" && one !== ">") {
      throw new ShellParseError(`unexpected character ${one}`, line, column);
    }
    this.tokens.push(Object.freeze({ kind: "operator", text: one, line, column }));
  }

  /** The delimiter is read immediately; the body arrives at the next newline. */
  private declareHeredoc(stripTabs: boolean): HeredocRecord {
    this.skipBlanks();
    const { line, column } = this;
    const word = this.readWordParts((char) => char === "\n" || char === " " || char === "\t" || OPERATOR_START.has(char));
    if (word.length === 0) throw new ShellParseError("a here-document requires a delimiter", line, column);
    if (word.some((part) => part.kind !== "literal")) {
      throw new ShellParseError("a here-document delimiter must be a literal word", line, column);
    }
    const quoted = word.some((part) => part.kind === "literal" && part.quoted);
    const delimiter = word.map((part) => (part.kind === "literal" ? part.text : "")).join("");
    const record: HeredocRecord = { stripTabs, delimiter, quoted, body: Object.freeze([]) };
    this.pendingHeredocs.push(record);
    return record;
  }

  private readPendingHeredocs(): void {
    while (this.pendingHeredocs.length > 0) {
      const record = this.pendingHeredocs.shift()!;
      const startLine = this.line;
      const lines: string[] = [];
      for (;;) {
        if (this.atEnd()) {
          throw new ShellParseError(`unterminated here-document; expected the delimiter ${record.delimiter}`, startLine, 1);
        }
        let raw = "";
        while (!this.atEnd() && this.peek() !== "\n") raw += this.next();
        if (!this.atEnd()) this.next();
        const candidate = record.stripTabs ? raw.replace(/^\t+/u, "") : raw;
        if (candidate === record.delimiter) break;
        lines.push(candidate);
      }
      const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
      record.body = record.quoted
        ? Object.freeze([Object.freeze({ kind: "literal", text: body, quoted: true }) as WordPart])
        : new Lexer(body, startLine, 1).readHeredocBody();
    }
  }

  private readHeredocBody(): Word {
    const parts: WordPart[] = [];
    this.readQuotedBody((part) => {
      const last = parts[parts.length - 1];
      if (part.kind === "literal" && last?.kind === "literal" && last.quoted === part.quoted) {
        parts[parts.length - 1] = Object.freeze({ kind: "literal", text: last.text + part.text, quoted: last.quoted });
        return;
      }
      parts.push(part);
    }, undefined);
    return Object.freeze(parts);
  }

  private skipBlanks(): void {
    while (!this.atEnd() && (this.peek() === " " || this.peek() === "\t")) this.next();
  }

  private atEnd(): boolean {
    return this.index >= this.source.length;
  }

  private peek(offset = 0): string {
    return this.source[this.index + offset] ?? "";
  }

  private next(): string {
    const char = this.source[this.index] ?? "";
    this.index += 1;
    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return char;
  }

  private error(message: string): ShellParseError {
    return new ShellParseError(message, this.line, this.column);
  }
}

function parseParameterOperator(
  rest: string,
): Readonly<{ operator: ParameterOperator; colon: boolean; consumed: number }> | undefined {
  const colon = rest.startsWith(":");
  const body = colon ? rest.slice(1) : rest;
  const head = body[0] ?? "";
  if (head === "-") return Object.freeze({ operator: "use-default", colon, consumed: colon ? 2 : 1 });
  if (head === "=") return Object.freeze({ operator: "assign-default", colon, consumed: colon ? 2 : 1 });
  if (head === "?") return Object.freeze({ operator: "error-if-unset", colon, consumed: colon ? 2 : 1 });
  if (head === "+") return Object.freeze({ operator: "alternative", colon, consumed: colon ? 2 : 1 });
  if (colon) return undefined;
  if (body.startsWith("##")) return Object.freeze({ operator: "remove-largest-prefix", colon: false, consumed: 2 });
  if (body.startsWith("#")) return Object.freeze({ operator: "remove-smallest-prefix", colon: false, consumed: 1 });
  if (body.startsWith("%%")) return Object.freeze({ operator: "remove-largest-suffix", colon: false, consumed: 2 });
  if (body.startsWith("%")) return Object.freeze({ operator: "remove-smallest-suffix", colon: false, consumed: 1 });
  return undefined;
}
