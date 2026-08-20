import { readFileSync, readdirSync, statSync } from "node:fs";
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

describe("Prime production provider stack contract", () => {
  it("keeps the built-in provider registry opt-in outside the web product", () => {
    const offenders = productionTypeScriptFiles(srcRoot)
      .filter((path) => !path.endsWith("/prime/ai/providers/register-builtins.ts"))
      .filter((path) => readFileSync(path, "utf8").includes("register-builtins"))
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
