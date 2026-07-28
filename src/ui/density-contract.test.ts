import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const styles = await readAirshipStyles();
const uiDirectory = new URL("./", import.meta.url);
const sheets = await Promise.all((await collectCss(uiDirectory)).map(async (url) => ({
  url,
  source: await readFile(url, "utf8"),
})));

/*
 * Every rung of the ramp, and the field floor. `--fs-h3` is the retired alias
 * and resolves to `--fs-title`; it is listed so a call site that still uses it
 * is not reported as frozen while it waits to be re-homed by role.
 */
const RAMP = Object.freeze([
  "--fs-micro", "--fs-caption", "--fs-meta", "--fs-body",
  "--fs-lead", "--fs-title", "--fs-display", "--fs-hero",
  "--fs-h3", "--fs-field",
] as const);

describe("the Type scale preference governs every size", () => {
  /*
   * The browser assertion is in `route-adversarial-audit.spec.ts`, which drives
   * a real page at `x-large` and compares computed sizes element by element.
   * This is its static half: a size that names no ramp token cannot respond to
   * `--type-scale`, so it is frozen no matter what the page reports on the day.
   *
   * Nine elements failed this before the ramp pass — the wordmark, the runtime
   * status line, both disclosure chevrons, both skip links and the largest
   * heading among them.
   */
  it("declares no size that --type-scale cannot move", () => {
    const frozen: string[] = [];
    for (const { url, source } of sheets) {
      if (url.pathname.endsWith("/tokens.css")) continue;
      const css = source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
      for (const declaration of css.matchAll(/font-size\s*:\s*([^;}{]+)/gu)) {
        const value = (declaration[1] ?? "").trim();
        // `inherit` is not a size; it defers to an ancestor that has one.
        if (value === "inherit" || value === "inherit;") continue;
        if (!RAMP.some((token) => value.includes(token)) && !value.includes("--type-scale")) {
          frozen.push(`${url.pathname}: font-size: ${value}`);
        }
      }
    }
    expect(frozen).toEqual([]);
  });

  it("keeps the field floor a floor rather than a fixed size", () => {
    // Mobile Safari's zoom guard needs >= 16px; the reader's preference must
    // still be able to raise it. `max()` is what makes it both.
    expect(styles).toContain("--fs-field: max(16px, var(--fs-body));");
  });
});

describe("global density contract", () => {
  it("defines systemic comfortable and compact tokens", () => {
    const comfortable = densityBlock("comfortable");
    const compact = densityBlock("compact");
    for (const token of ["--density-control", "--density-row", "--density-gap", "--density-panel-pad", "--density-chat-measure", "--density-sidebar", "--lh-body"]) {
      expect(comfortable).toContain(token);
      expect(compact).toContain(token);
    }
    expect(styles).toContain(":root[data-density] .message-body");
    expect(styles).toContain(":root[data-density] .composer textarea");
    expect(styles).toContain(":root[data-density] .profile-form");
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

function densityBlock(name: string): string {
  const match = styles.match(new RegExp(`:root\\[data-density="${name}"\\]\\s*\\{([^}]+)\\}`, "u"));
  return match?.[1] ?? "";
}
