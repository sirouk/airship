import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return productionTypeScriptFiles(path);
    if (!/\.tsx?$/u.test(name) || /(?:\.|-)test(?:-support)?\.tsx?$/u.test(name)) return [];
    return [path];
  });
}

/*
 * The built-in provider stack used to live at `src/prime/ai/providers/`: 5,053
 * lines of production code that chose behaviour from a provider *name* —
 * `isZai`, `isMoonshot`, `isGrok`, `github-copilot`, `openrouter`, `cerebras`,
 * `deepseek` — with a registration entry point this file forbade anything from
 * importing. Nothing shipped it, so no artifact ever changed; the cost was that
 * the first 5,053 lines a newcomer read under `src/prime/ai` did the exact
 * opposite of the rule this product states, which is that a transport is chosen
 * by its wire protocol and never by who is behind it.
 *
 * It is deleted. This file now refuses its return rather than its import,
 * which is the stronger refusal of the two: an unimported directory is exactly
 * what it was before.
 */
describe("Prime production provider stack contract", () => {
  it("has no built-in provider registry to keep opt-in", () => {
    expect(existsSync(resolve(srcRoot, "prime/ai/providers"))).toBe(false);

    const offenders = productionTypeScriptFiles(srcRoot)
      .filter((path) => readFileSync(path, "utf8").includes("register-builtins"))
      .map((path) => relative(srcRoot, path));

    expect(offenders).toEqual([]);
  });

  it("chooses a transport by wire, never by provider identity", () => {
    // The names the deleted stack branched on. A production file that spells one
    // of them again is re-introducing provider-ID dispatch under a new roof.
    const providerIdentityBranch =
      /\b(?:isZai|isMoonshot|isGrok|isDeepSeek|isCloudflareProvider|isGithubCopilot)\b/u;
    const offenders = productionTypeScriptFiles(srcRoot)
      .filter((path) => providerIdentityBranch.test(readFileSync(path, "utf8")))
      .map((path) => relative(srcRoot, path));

    expect(offenders).toEqual([]);
  });

  it("requires Airship transport or an explicit test/embed stream function", () => {
    const session = readFileSync(resolve(srcRoot, "prime/runtime/session.ts"), "utf8");

    expect(session).not.toContain("registryStreamSimple");
    expect(session).not.toMatch(/adapted\s*\?\?\s*streamSimple/u);
    expect(session).toContain("requires an admitted inference transport or an explicit streamFn");
  });
});
