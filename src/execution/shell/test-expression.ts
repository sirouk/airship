import type { ShellRuntime } from "./command";
import { usageError } from "./errors";

/**
 * POSIX `test` / `[`.
 *
 * Two operators are deliberately answered rather than faked:
 * `-x` is always false because this filesystem has no execute bit, and the
 * device/terminal predicates (`-b -c -p -S -t -g -u -k -O -G`) raise a usage
 * error because there is no device, terminal, or ownership model to consult.
 * Returning a plausible-looking `false` for those would be a quiet lie.
 */
export function evaluateTest(argv: readonly string[], shell: ShellRuntime): number {
  const parser = new TestParser(argv, shell);
  const value = parser.parseExpression();
  parser.expectEnd();
  return value ? 0 : 1;
}

const UNARY_FILE_TESTS = new Set(["-e", "-f", "-d", "-s", "-r", "-w", "-x", "-h", "-L"]);
const UNARY_STRING_TESTS = new Set(["-z", "-n"]);
const UNSUPPORTED_UNARY = new Set(["-b", "-c", "-p", "-S", "-t", "-g", "-u", "-k", "-O", "-G", "-N"]);
const BINARY_OPERATORS = new Set(["=", "==", "!=", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef"]);

class TestParser {
  private position = 0;

  constructor(private readonly argv: readonly string[], private readonly shell: ShellRuntime) {}

  parseExpression(): boolean {
    return this.parseOr();
  }

  expectEnd(): void {
    if (this.position !== this.argv.length) throw usageError("test", `unexpected argument: ${this.argv[this.position]}`);
  }

  private parseOr(): boolean {
    let value = this.parseAnd();
    while (this.peek() === "-o") {
      this.advance();
      value = this.parseAnd() || value;
    }
    return value;
  }

  private parseAnd(): boolean {
    let value = this.parseUnary();
    while (this.peek() === "-a") {
      this.advance();
      value = this.parseUnary() && value;
    }
    return value;
  }

  private parseUnary(): boolean {
    if (this.peek() === "!") {
      this.advance();
      return !this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): boolean {
    const token = this.peek();
    if (token === undefined) throw usageError("test", "expected an expression");
    if (token === "(") {
      this.advance();
      const value = this.parseOr();
      if (this.peek() !== ")") throw usageError("test", "expected `)`");
      this.advance();
      return value;
    }
    // A binary operator is checked before a unary one so `-n = -n` compares
    // strings instead of being read as a nested unary test.
    const operator = this.argv[this.position + 1];
    if (operator !== undefined && BINARY_OPERATORS.has(operator)) {
      this.advance();
      this.advance();
      const right = this.peek();
      if (right === undefined) throw usageError("test", `${operator} requires two operands`);
      this.advance();
      return this.applyBinary(operator, token, right);
    }
    if (UNSUPPORTED_UNARY.has(token)) {
      throw usageError(
        "test",
        `${token} needs a device, terminal, or ownership model that airship-sh does not have`,
      );
    }
    if (UNARY_STRING_TESTS.has(token)) {
      this.advance();
      const operand = this.peek();
      if (operand === undefined) throw usageError("test", `${token} requires an operand`);
      this.advance();
      return token === "-z" ? operand.length === 0 : operand.length > 0;
    }
    if (UNARY_FILE_TESTS.has(token)) {
      this.advance();
      const operand = this.peek();
      if (operand === undefined) throw usageError("test", `${token} requires an operand`);
      this.advance();
      return this.applyFileTest(token, operand);
    }
    this.advance();
    return token.length > 0;
  }

  private applyFileTest(operator: string, operand: string): boolean {
    const path = this.shell.fs.resolve(operand);
    switch (operator) {
      case "-e":
        return this.shell.fs.exists(path);
      case "-f":
        return this.shell.fs.isFile(path);
      case "-d":
        return this.shell.fs.isDirectory(path);
      case "-s":
        return this.shell.fs.isFile(path) && this.shell.fs.stat(path).size > 0;
      case "-r":
        return this.shell.fs.exists(path);
      case "-w":
        return this.shell.fs.exists(path) && this.isWritable(path);
      case "-x":
        // No execute bit exists in the workspace, so this is honestly false.
        return false;
      default:
        // `-h`/`-L`: there are no symlinks in this filesystem, so nothing is one.
        return false;
    }
  }

  private isWritable(path: string): boolean {
    try {
      this.shell.fs.assertWritablePath(path);
      return true;
    } catch {
      return false;
    }
  }

  private applyBinary(operator: string, left: string, right: string): boolean {
    switch (operator) {
      case "=":
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return left < right;
      case ">":
        return left > right;
      case "-nt":
      case "-ot": {
        const leftPath = this.shell.fs.resolve(left);
        const rightPath = this.shell.fs.resolve(right);
        if (!this.shell.fs.exists(leftPath) || !this.shell.fs.exists(rightPath)) return false;
        const leftTime = this.shell.fs.stat(leftPath).updatedAt;
        const rightTime = this.shell.fs.stat(rightPath).updatedAt;
        return operator === "-nt" ? leftTime > rightTime : leftTime < rightTime;
      }
      case "-ef":
        return this.shell.fs.resolve(left) === this.shell.fs.resolve(right);
      default: {
        const leftValue = parseIntegerOperand(operator, left);
        const rightValue = parseIntegerOperand(operator, right);
        switch (operator) {
          case "-eq":
            return leftValue === rightValue;
          case "-ne":
            return leftValue !== rightValue;
          case "-lt":
            return leftValue < rightValue;
          case "-le":
            return leftValue <= rightValue;
          case "-gt":
            return leftValue > rightValue;
          default:
            return leftValue >= rightValue;
        }
      }
    }
  }

  private peek(): string | undefined {
    return this.argv[this.position];
  }

  private advance(): void {
    this.position += 1;
  }
}

function parseIntegerOperand(operator: string, raw: string): bigint {
  const trimmed = raw.trim();
  if (!/^[+-]?[0-9]+$/u.test(trimmed)) throw usageError("test", `${operator} expects integer operands: ${raw}`);
  return BigInt(trimmed);
}
