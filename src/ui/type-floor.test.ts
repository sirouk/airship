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

  /*
   * The floor above is only half the promise. A literal *anywhere* is a size
   * the Type scale preference cannot move — WCAG 1.4.4 asks that text scale to
   * 200%, and a `font-size: 11px` does not scale at all. There were 60 of them
   * across 17 sheets, 29 at 11px, and their consequence was measurable:
   * `data-type-scale="x-large"` moved 39 of 48 elements on #chat and froze the
   * wordmark, the runtime line, both disclosure chevrons and the largest
   * heading, so every relationship tuned at 1x was wrong at 1.25x.
   *
   * `tokens.css` is the one exception, because that is where the ramp is
   * *defined* — the rem bases and the two per-density root sizes everything
   * else is relative to.
   */
  it("declares every size through the ramp, so the Type scale preference governs all of it", () => {
    const violations: string[] = [];
    for (const { url, source } of sources) {
      if (url.pathname.endsWith("/tokens.css")) continue;
      const css = source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
      for (const declaration of css.matchAll(/font-size\s*:\s*([^;}{]+)/gu)) {
        if (/(?:^|[\s(])\d*\.?\d+px/u.test(declaration[1] ?? "")) {
          violations.push(`${url.pathname}:${lineAt(source, declaration.index)} ${declaration[0].trim()}`);
        }
      }
      /*
       * The `font:` shorthand hides a size in the middle of a list. A px value
       * there is a size unless it follows a `/`, which is the line-height slot
       * — line-heights are a separate contract and are not asserted here.
       */
      for (const declaration of css.matchAll(/font\s*:\s*([^;}{]+)/gu)) {
        if (/(?<!\/\s{0,4})(?:^|[\s(])\d*\.?\d+px/u.test(declaration[1] ?? "")) {
          violations.push(`${url.pathname}:${lineAt(source, declaration.index)} ${declaration[0].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the Airship logo outside the status vocabulary", async () => {
    const markdownStyles = await readFile(new URL("./chat/message-parts-view.css", import.meta.url), "utf8");
    expect(markdownStyles).not.toContain("var(--copper)");

    const shellStyles = await readFile(new URL("./shell.css", import.meta.url), "utf8");
    const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(rulesFor(shellStyles, "var(--copper)")).toEqual(['.status-mark[data-state="asserted"]']);
    expect(rulesFor(shellStyles, "var(--brand-mark)")).toEqual([".brand-mark", ".brand-mark::after"]);
    expect(app).toContain('<span class="brand-mark" aria-hidden="true"><Icon name="airship" size={25} /></span>');
    expect(app).not.toMatch(/<StatusMark[^>]*brand-mark/u);
  });
});

/** The selectors of every rule whose body spends `value`, sorted and deduped. */
function rulesFor(source: string, value: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const selectors = [...css.matchAll(/([^{}]+)\{([^}]*)\}/gu)]
    .filter((rule) => (rule[2] ?? "").includes(value))
    .flatMap((rule) => (rule[1] ?? "").split(",").map((selector) => selector.trim()));
  return [...new Set(selectors)].sort();
}

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
