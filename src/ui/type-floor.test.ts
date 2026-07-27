import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const uiDirectory = new URL("./", import.meta.url);
const cssFiles = await collectCss(uiDirectory);
const sources = await Promise.all(cssFiles.map(async (url) => ({ url, source: await readFile(url, "utf8") })));

describe("global typography floor", () => {
  it("defines the scalable 11px floor as the canonical micro token", async () => {
    const styles = await readAirshipStyles();
    expect(styles).toContain("--fs-micro: calc(.6875rem * var(--type-scale))");
    expect(styles).toMatch(/data-type-scale="large"[^}]*--type-scale:\s*1\.125/su);
    expect(styles).toMatch(/data-type-scale="x-large"[^}]*--type-scale:\s*1\.25/su);
  });

  it("contains no literal font declaration below 11px in any UI stylesheet", () => {
    const violations: string[] = [];
    for (const { url, source } of sources) {
      for (const declaration of source.matchAll(/font(?:-size)?\s*:\s*([^;}{]+)/gu)) {
        const size = declaration[1]?.match(/(\d*\.?\d+)(px|rem)\b/u);
        if (!size) continue;
        const pixels = size[2] === "rem" ? Number(size[1]) * 16 : Number(size[1]);
        if (pixels < 11) violations.push(`${url.pathname}:${lineAt(source, declaration.index)} ${declaration[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("reserves copper for the asserted seal and brand mark", async () => {
    const markdownStyles = await readFile(new URL("./chat/message-parts-view.css", import.meta.url), "utf8");
    expect(markdownStyles).not.toContain("var(--copper)");
  });
});

async function collectCss(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<URL[]> => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return collectCss(url);
    return entry.name.endsWith(".css") ? [url] : [];
  }));
  return nested.flat();
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}
