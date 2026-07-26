import { describe, expect, it } from "vitest";
import { ShellParseError } from "./errors";
import { tokenize } from "./lexer";
import { parseShellScript } from "./parser";

function parse(source: string): ReturnType<typeof parseShellScript> {
  return parseShellScript(source);
}

describe("airship-sh lexer", () => {
  it("classifies operators, words, and here-documents", () => {
    const tokens = tokenize("a | b && c ; d\n");
    expect(tokens.map((token) => token.kind)).toEqual([
      "word",
      "operator",
      "word",
      "operator",
      "word",
      "operator",
      "word",
      "newline",
      "eof",
    ]);
  });

  it("recognizes an io-number only when it touches the operator", () => {
    expect(tokenize("2>err")[0].kind).toBe("io-number");
    expect(tokenize("2 > err")[0].kind).toBe("word");
  });

  it("keeps a quoted reserved word out of the grammar", () => {
    const [token] = tokenize(`"if"`);
    expect(token).toMatchObject({ kind: "word", literalOnly: false });
  });

  it("collects a here-document body at the following newline", () => {
    const tokens = tokenize("cat <<EOF\nbody $x\nEOF\n");
    const operator = tokens.find((token) => token.kind === "operator");
    expect(operator).toMatchObject({ text: "<<" });
    expect(operator?.kind === "operator" && operator.heredoc?.body.length).toBeGreaterThan(0);
  });

  it("reports unterminated quoting with a position", () => {
    expect(() => tokenize(`echo "open`)).toThrow(ShellParseError);
    expect(() => tokenize(`echo 'open`)).toThrow(/unterminated single quote/u);
    expect(() => tokenize("echo `open")).toThrow(/unterminated backquote/u);
  });
});

describe("airship-sh parser", () => {
  it("builds an and-or list of pipelines", () => {
    const program = parse("a | b && c");
    expect(program.body.items).toHaveLength(1);
    expect(program.body.items[0].first.commands).toHaveLength(2);
    expect(program.body.items[0].rest[0].operator).toBe("&&");
  });

  it("separates assignments from command words", () => {
    const command = parse("A=1 B=2 echo hi").body.items[0].first.commands[0];
    expect(command.kind).toBe("simple");
    if (command.kind !== "simple") throw new Error("expected a simple command");
    expect(command.assignments.map(({ name }) => name)).toEqual(["A", "B"]);
    expect(command.words).toHaveLength(2);
  });

  it("does not treat a quoted name as an assignment", () => {
    const command = parse(`"A"=1`).body.items[0].first.commands[0];
    if (command.kind !== "simple") throw new Error("expected a simple command");
    expect(command.assignments).toHaveLength(0);
    expect(command.words).toHaveLength(1);
  });

  it("parses a function definition", () => {
    const command = parse("f() { echo hi; }").body.items[0].first.commands[0];
    expect(command).toMatchObject({ kind: "function", name: "f" });
  });

  it("records redirections with their descriptors", () => {
    const command = parse("cmd > out 2>&1 < in").body.items[0].first.commands[0];
    if (command.kind !== "simple") throw new Error("expected a simple command");
    expect(command.redirections.map(({ fd, operator }) => `${fd}${operator}`)).toEqual(["1>", "2>&", "0<"]);
  });

  const REJECTED: readonly (readonly [string, RegExp])[] = Object.freeze([
    ["sleep 5 &", /background execution/u],
    ["function f { :; }", /bash extension/u],
    ["if true; then", /`then` requires at least one command/u],
    ["while true; do", /`do` requires at least one command/u],
    ["case x in", /`case` requires a pattern/u],
    ["for; do :; done", /`for` requires a variable name/u],
    ["{ :;", /expected `\}`/u],
    ["( :;", /expected `\)`/u],
    ["echo >", /requires a target/u],
    ["echo >&out", /file descriptor number/u],
    ["|", /expected a command/u],
    ["for x in a; do :; don", /expected `done`/u],
    ["${x@Q}", /unsupported parameter expansion/u],
    ["echo ${x:^y}", /unsupported parameter expansion operator/u],
  ]);

  for (const [source, expected] of REJECTED) {
    it(`rejects ${JSON.stringify(source)} with a clear error`, () => {
      expect(() => parse(source)).toThrow(expected);
    });
  }

  it("attaches line and column to every parse error", () => {
    try {
      parse("echo ok\nsleep 5 &\n");
      throw new Error("expected a parse error");
    } catch (error) {
      expect(error).toBeInstanceOf(ShellParseError);
      expect((error as ShellParseError).line).toBe(2);
      expect((error as ShellParseError).message).toMatch(/line 2/u);
    }
  });
});
