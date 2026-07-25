import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type CssSource = Readonly<{
  file: string;
  text: string;
}>;

type CssVariableReference = Readonly<{
  name: string;
  hasFallback: boolean;
  line: number;
}>;

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const cssSources = await readCssSources(sourceRoot);

describe("CSS variable contract", () => {
  it("defines every source variable reference that has no local fallback", () => {
    const definitions = new Set(
      cssSources.flatMap(({ text }) => customPropertyDefinitions(text)),
    );
    const missing = cssSources.flatMap(({ file, text }) => (
      customPropertyReferences(text)
        .filter(({ name, hasFallback }) => !hasFallback && !definitions.has(name))
        .map(({ name, line }) => `${relative(sourceRoot, file)}:${line} ${name}`)
    ));

    expect(
      missing,
      [
        "Undefined CSS variables make complete declarations invalid at runtime.",
        "Define the token in the shared theme, replace it with a canonical token,",
        "or provide an explicit fallback for a deliberately runtime-owned value.",
      ].join(" "),
    ).toEqual([]);
  });
});

async function readCssSources(directory: string): Promise<CssSource[]> {
  const sources: CssSource[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await readCssSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      sources.push({ file: path, text: await readFile(path, "utf8") });
    }
  }
  return sources;
}

function customPropertyDefinitions(source: string): string[] {
  return [...withoutComments(source).matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function customPropertyReferences(source: string): CssVariableReference[] {
  const css = withoutComments(source);
  const references: CssVariableReference[] = [];
  const pattern = /var\(\s*(--[\w-]+)/gu;
  for (const match of css.matchAll(pattern)) {
    const name = match[1];
    const start = match.index;
    if (!name || start === undefined) continue;

    let depth = 1;
    let hasFallback = false;
    let cursor = start + match[0].length;
    while (cursor < css.length && depth > 0) {
      const character = css[cursor];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 1) hasFallback = true;
      cursor += 1;
    }

    references.push({
      name,
      hasFallback,
      line: css.slice(0, start).split("\n").length,
    });
  }
  return references;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => (
    comment.replace(/[^\n]/gu, " ")
  ));
}
