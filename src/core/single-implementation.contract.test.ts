import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One question, one function.
 *
 * A Pass 2 audit counted the same helper written out again and again with the
 * copies quietly disagreeing: `deepFreeze` twenty times in two behaviours (half
 * terminate on a self-referential object, half overflow the stack), `formatBytes`
 * eight times in two unit vocabularies (the same `navigator.storage.estimate()`
 * reading printed "256 MB" on #capabilities and "256 MiB" on #vault),
 * `stringArgument` seven times under three contracts, `truncateUtf8` twice at
 * opposite ends of one pipeline, and `crypto.randomUUID` called raw in three
 * places that bypassed the module carrying the LAN-origin fallback.
 *
 * Counting declarations in the source is the only assertion that can catch a
 * *second* copy appearing: a behavioural test passes happily against either one.
 *
 * `src/ui` is bounded rather than pinned to zero because this pass owns the
 * non-UI tree; the UI copies are a separate owner's edit. The bounds below only
 * ever go down, so they cannot block that fix, and they cannot be raised without
 * an explicit edit here.
 */

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceRoot, "..");

function sourceFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/u.test(entry.name)) {
        found.push(relative(repositoryRoot, full));
      }
    }
  };
  walk(repositoryRoot);
  return found;
}

const FILES = sourceFiles();
const PRODUCTION = FILES.filter((file) => !/\.test\.tsx?$/u.test(file));
const IN_UI = (file: string) => file.startsWith("ui/");

function declaring(pattern: RegExp, files: readonly string[] = PRODUCTION): readonly string[] {
  return files.filter((file) => pattern.test(readFileSync(resolve(repositoryRoot, file), "utf8")));
}

describe("one implementation per question", () => {
  it("declares deepFreeze once outside the UI, and freezing a cycle terminates", async () => {
    const declarations = declaring(/^(?:export )?function deepFreeze</mu);
    expect(declarations.filter((file) => !IN_UI(file))).toEqual(["core/freeze.ts"]);
    // src/ui/attestations-model.ts is the twentieth copy; src/ui belongs to a
    // different owner in this pass. Never raise this number.
    expect(declarations.filter(IN_UI).length).toBeLessThanOrEqual(1);

    // The behaviour the eight recurse-then-freeze copies got wrong. A fork seed
    // that points back at its parent turn is an ordinary journal-derived record.
    const { deepFreeze } = await import("./freeze");
    const cyclic: Record<string, unknown> = { id: "turn-1" };
    cyclic.parent = cyclic;
    expect(() => deepFreeze(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
  });

  it("declares formatBytes once outside the UI, on the binary vocabulary its divisor earns", async () => {
    const declarations = declaring(/^(?:export )?function formatBytes\(/mu);
    expect(declarations.filter((file) => !IN_UI(file))).toEqual(["core/bytes.ts"]);
    // Five `formatBytes` copies remain in src/ui, plus `formatVaultBytes` and
    // `formatLocalDeviceBytes` under other names. Never raise this number.
    expect(declarations.filter(IN_UI).length).toBeLessThanOrEqual(5);

    const { formatBytes } = await import("./bytes");
    const { measuredBytesLabel } = await import("../capabilities/runtime-load");
    // The exact reading that read two ways: 256 MiB of origin usage.
    expect(formatBytes(268_435_456)).toBe("256 MiB");
    expect(measuredBytesLabel({ state: "measured", bytes: 268_435_456, detail: "origin usage" }))
      .toBe(formatBytes(268_435_456));
  });

  it("routes every identity through core/id.ts, including on a LAN origin", () => {
    const raw = PRODUCTION.filter((file) =>
      file !== "core/id.ts" && readFileSync(resolve(repositoryRoot, file), "utf8").includes("crypto.randomUUID"));
    expect(raw).toEqual([]);
  });

  it("declares truncateUtf8 once, so both ends of the summary pipeline cut at the same character", () => {
    expect(declaring(/^(?:export )?function truncateUtf8\(/mu)).toEqual(["core/context-summary-projection.ts"]);
  });

  it("declares the tool argument coercers only in the tools' shared vocabulary", () => {
    expect(declaring(/^(?:export )?function objectArguments\(/mu)).toEqual(["tools/schema.ts"]);
    expect(declaring(/^(?:export )?function stringArgument\(/mu)).toEqual([]);
    expect(declaring(/^(?:export )?function requiredString\(value: JsonValue/mu)).toEqual(["tools/schema.ts"]);
  });

  it("gives the shipped Chutes sign-in the shared PKCE primitives rather than copies", () => {
    const chutes = readFileSync(resolve(repositoryRoot, "auth/chutes-oauth.ts"), "utf8");
    expect(chutes).not.toMatch(/^function (?:bytesToBase64Url|constantTimeEqual|randomBase64Url)\(/mu);
    expect(chutes).toContain('} from "./provider-oauth/pkce";');
    // The hardcoded 48/32 that made PKCE_VERIFIER_BYTES an importerless constant.
    expect(chutes).not.toContain("randomBase64Url(48,");
    expect(chutes).not.toContain("randomBase64Url(32,");
  });
});
