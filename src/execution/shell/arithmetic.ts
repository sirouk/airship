import { ShellCommandError } from "./errors";

/**
 * POSIX shell arithmetic.
 *
 * Values are 64-bit two's-complement integers, wrapped with `BigInt.asIntN`
 * after every operation, because that is what a POSIX shell's `long` does. It
 * is not JavaScript double arithmetic and it is not arbitrary precision, and
 * saying so precisely is cheaper than a surprising overflow.
 */
export interface ArithmeticScope {
  read(name: string): string | undefined;
  assign(name: string, value: string): void;
}

const MAX_VARIABLE_DEPTH = 8;

export function evaluateArithmetic(source: string, scope: ArithmeticScope): bigint {
  return new ArithmeticEvaluator(source, scope, 0).evaluate();
}

type ArithToken =
  | Readonly<{ kind: "number"; value: bigint }>
  | Readonly<{ kind: "name"; value: string }>
  | Readonly<{ kind: "operator"; value: string }>
  | Readonly<{ kind: "end" }>;

const OPERATORS = Object.freeze([
  "<<=",
  ">>=",
  "**",
  "++",
  "--",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "~",
  "&",
  "|",
  "^",
  "?",
  ":",
  "(",
  ")",
  ",",
  "=",
]);

class ArithmeticEvaluator {
  private readonly tokens: readonly ArithToken[];
  private position = 0;

  constructor(source: string, private readonly scope: ArithmeticScope, private readonly depth: number) {
    if (depth > MAX_VARIABLE_DEPTH) throw new ShellCommandError("arithmetic: variable expansion nested too deeply", 2);
    this.tokens = tokenizeArithmetic(source);
  }

  evaluate(): bigint {
    if (this.peek().kind === "end") return 0n;
    const value = this.parseComma();
    if (this.peek().kind !== "end") throw this.error("unexpected trailing input");
    return value;
  }

  private parseComma(): bigint {
    let value = this.parseAssignment();
    while (this.atOperator(",")) {
      this.advance();
      value = this.parseAssignment();
    }
    return value;
  }

  private parseAssignment(): bigint {
    const start = this.position;
    const token = this.peek();
    if (token.kind === "name") {
      const operator = this.tokens[this.position + 1];
      if (operator?.kind === "operator" && isAssignmentOperator(operator.value)) {
        this.advance();
        this.advance();
        const right = this.parseAssignment();
        const next = operator.value === "="
          ? right
          : applyBinary(operator.value.slice(0, -1), this.readVariable(token.value), right);
        this.scope.assign(token.value, wrap(next).toString());
        return wrap(next);
      }
    }
    this.position = start;
    return this.parseConditional();
  }

  private parseConditional(): bigint {
    const condition = this.parseBinary(0);
    if (!this.atOperator("?")) return condition;
    this.advance();
    const whenTrue = this.parseAssignment();
    if (!this.atOperator(":")) throw this.error("expected `:` in a conditional expression");
    this.advance();
    const whenFalse = this.parseConditional();
    return condition !== 0n ? whenTrue : whenFalse;
  }

  private parseBinary(level: number): bigint {
    if (level >= PRECEDENCE.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind !== "operator" || !PRECEDENCE[level].includes(token.value)) return left;
      this.advance();
      // `&&` and `||` short-circuit, so the right side must not be evaluated
      // eagerly: `x != 0 && 10 / x` is a legal guard.
      if (token.value === "&&") {
        const right = this.parseBinary(level + 1);
        left = left !== 0n && right !== 0n ? 1n : 0n;
        continue;
      }
      if (token.value === "||") {
        const right = this.parseBinary(level + 1);
        left = left !== 0n || right !== 0n ? 1n : 0n;
        continue;
      }
      left = applyBinary(token.value, left, this.parseBinary(level + 1));
    }
  }

  private parseUnary(): bigint {
    const token = this.peek();
    if (token.kind === "operator") {
      if (token.value === "-") {
        this.advance();
        return wrap(-this.parseUnary());
      }
      if (token.value === "+") {
        this.advance();
        return this.parseUnary();
      }
      if (token.value === "!") {
        this.advance();
        return this.parseUnary() === 0n ? 1n : 0n;
      }
      if (token.value === "~") {
        this.advance();
        return wrap(~this.parseUnary());
      }
      if (token.value === "++" || token.value === "--") {
        this.advance();
        const target = this.peek();
        if (target.kind !== "name") throw this.error(`${token.value} requires a variable`);
        this.advance();
        const next = wrap(this.readVariable(target.value) + (token.value === "++" ? 1n : -1n));
        this.scope.assign(target.value, next.toString());
        return next;
      }
    }
    return this.parsePostfix();
  }

  private parsePostfix(): bigint {
    const token = this.peek();
    if (token.kind === "name") {
      const operator = this.tokens[this.position + 1];
      if (operator?.kind === "operator" && (operator.value === "++" || operator.value === "--")) {
        this.advance();
        this.advance();
        const current = this.readVariable(token.value);
        this.scope.assign(token.value, wrap(current + (operator.value === "++" ? 1n : -1n)).toString());
        return current;
      }
    }
    return this.parsePrimary();
  }

  private parsePrimary(): bigint {
    const token = this.advance();
    if (token.kind === "number") return token.value;
    if (token.kind === "name") return this.readVariable(token.value);
    if (token.kind === "operator" && token.value === "(") {
      const value = this.parseComma();
      if (!this.atOperator(")")) throw this.error("expected `)`");
      this.advance();
      return value;
    }
    throw this.error("expected an operand");
  }

  private readVariable(name: string): bigint {
    const raw = (this.scope.read(name) ?? "").trim();
    if (raw === "") return 0n;
    const literal = parseIntegerLiteral(raw);
    if (literal !== undefined) return literal;
    return new ArithmeticEvaluator(raw, this.scope, this.depth + 1).evaluate();
  }

  private atOperator(value: string): boolean {
    const token = this.peek();
    return token.kind === "operator" && token.value === value;
  }

  private peek(): ArithToken {
    return this.tokens[this.position] ?? Object.freeze({ kind: "end" });
  }

  private advance(): ArithToken {
    const token = this.peek();
    if (this.position < this.tokens.length) this.position += 1;
    return token;
  }

  private error(message: string): ShellCommandError {
    return new ShellCommandError(`arithmetic: ${message}`, 2);
  }
}

const PRECEDENCE: readonly (readonly string[])[] = Object.freeze([
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
  ["**"],
]);

function isAssignmentOperator(value: string): boolean {
  return ["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="].includes(value);
}

function applyBinary(operator: string, left: bigint, right: bigint): bigint {
  switch (operator) {
    case "+":
      return wrap(left + right);
    case "-":
      return wrap(left - right);
    case "*":
      return wrap(left * right);
    case "/":
      if (right === 0n) throw new ShellCommandError("arithmetic: division by zero", 2);
      return wrap(left / right);
    case "%":
      if (right === 0n) throw new ShellCommandError("arithmetic: division by zero", 2);
      return wrap(left % right);
    case "**":
      if (right < 0n) throw new ShellCommandError("arithmetic: negative exponent", 2);
      return wrap(left ** right);
    case "<<":
      return wrap(left << BigInt.asUintN(6, right));
    case ">>":
      return wrap(left >> BigInt.asUintN(6, right));
    case "<":
      return left < right ? 1n : 0n;
    case "<=":
      return left <= right ? 1n : 0n;
    case ">":
      return left > right ? 1n : 0n;
    case ">=":
      return left >= right ? 1n : 0n;
    case "==":
      return left === right ? 1n : 0n;
    case "!=":
      return left !== right ? 1n : 0n;
    case "&":
      return wrap(left & right);
    case "|":
      return wrap(left | right);
    case "^":
      return wrap(left ^ right);
    default:
      throw new ShellCommandError(`arithmetic: unsupported operator ${operator}`, 2);
  }
}

function wrap(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

function parseIntegerLiteral(text: string): bigint | undefined {
  if (/^[+-]?0[xX][0-9a-fA-F]+$/u.test(text)) return wrap(BigInt(text.replace(/^\+/u, "")));
  if (/^[+-]?0[0-7]+$/u.test(text)) {
    const negative = text.startsWith("-");
    const digits = text.replace(/^[+-]/u, "");
    const value = BigInt(`0o${digits.slice(1)}`);
    return wrap(negative ? -value : value);
  }
  if (/^[+-]?[0-9]+$/u.test(text)) return wrap(BigInt(text.replace(/^\+/u, "")));
  return undefined;
}

function tokenizeArithmetic(source: string): readonly ArithToken[] {
  const tokens: ArithToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const match = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/u.exec(source.slice(index));
      if (!match) throw new ShellCommandError(`arithmetic: invalid number near ${source.slice(index, index + 8)}`, 2);
      const literal = parseIntegerLiteral(match[1]);
      if (literal === undefined) throw new ShellCommandError(`arithmetic: invalid number ${match[1]}`, 2);
      tokens.push(Object.freeze({ kind: "number", value: literal }));
      index += match[1].length;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index))!;
      tokens.push(Object.freeze({ kind: "name", value: match[0] }));
      index += match[0].length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (!operator) throw new ShellCommandError(`arithmetic: unexpected character ${char}`, 2);
    tokens.push(Object.freeze({ kind: "operator", value: operator }));
    index += operator.length;
  }
  tokens.push(Object.freeze({ kind: "end" }));
  return Object.freeze(tokens);
}
