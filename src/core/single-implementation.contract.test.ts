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
    // src/ui/runtime-copy.ts is the remaining UI copy in this pass; src/ui
    // belongs to a different owner here. Never raise this number.
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
    // Every UI surface imports the same binary vocabulary; no local copy remains.
    expect(declarations.filter(IN_UI)).toEqual([]);

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

  /*
   * "Is this a plain JSON object?" was written out in seventeen files, in three
   * spellings that agree: `Boolean(value) &&`, `!!value &&`, and
   * `value !== null &&`. They agree today; three spellings of one predicate are
   * three chances to stop agreeing, and every one of them guards a boundary
   * where untrusted JSON arrives.
   */
  it("declares isRecord once, for every boundary that reads untrusted JSON", async () => {
    expect(declaring(/^(?:export )?function isRecord\(/mu)).toEqual(["core/records.ts"]);

    const { isRecord } = await import("./records");
    expect(isRecord({})).toBe(true);
    // The three things every copy agreed were not records.
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  /*
   * A content digest is a promise that two devices computing it over the same
   * value get the same string. `profiles/domain.ts` carried `canonicalStringify`
   * — the same recursion, the same `JSON.stringify` of keys, and the same
   * code-unit key order — as a second implementation of that one preimage.
   *
   * `prime/harness/store.ts` keeps its own and is NOT folded in: it canonicalises
   * `unknown` rather than `JsonValue` and answers `"null"` for `undefined`,
   * where this one would emit invalid JSON. Different domain, different
   * behaviour, different question.
   */
  it("declares one canonical JSON preimage for content digests", async () => {
    expect(declaring(/^(?:export )?function stableStringify\(value: JsonValue/mu)).toEqual(["core/hash.ts"]);
    expect(declaring(/^(?:export )?function canonicalStringify\(/mu)).toEqual([]);

    const { stableStringify } = await import("./hash");
    // Code-unit order, which is where a `localeCompare` copy would diverge.
    expect(stableStringify({ a0b: 1, a_b: 2 })).toBe('{"a0b":1,"a_b":2}');
  });

  /*
   * The rest of `requiredString` is genuinely several questions, and stays
   * several functions. What is fixed here is the two pairs that were one
   * question written twice: the vault's byte-bounded record field, and the
   * kernel protocol's bounded string — the latter shared as a predicate so each
   * engine keeps raising its own protocol error, which callers branch on.
   */
  it("declares each remaining requiredString contract exactly once", () => {
    const byteBounded = declaring(/^(?:export )?function requiredString\(value: unknown, label: string, maxBytes: number/mu);
    expect(byteBounded).toEqual([]);
    expect(declaring(/^(?:export )?function requiredVaultString\(/mu)).toEqual(["vault/field.ts"]);
    expect(declaring(/^(?:export )?function boundedProtocolString\(/mu)).toEqual(["prime/kernel/kernel-contract.ts"]);
    // The kernel host and the Pyodide engine now share the one predicate. The
    // third occurrence is not a module: `pyodide-worker-source.ts` emits the
    // worker's own runtime as source text, inside a lexical scope that cannot
    // import anything, which is what makes it a different question.
    expect(declaring(/^\s*if \(typeof value !== "string" \|\| \(!allowEmpty && value\.length === 0\)/mu)).toEqual([
      "prime/kernel/kernel-contract.ts",
      "prime/kernel/pyodide-worker-source.ts",
    ]);
  });

  /*
   * `sha256Hex` is the hex spelling of a digest, which two wire formats need
   * and `core/hash.ts`'s `sha256:`-prefixed base64url form cannot give them.
   * The two `Uint8Array` copies were one question; the string-taking copies in
   * `inference/providers/openai-compatible-provider.ts` and `prime/ai/hash.ts`
   * are left alone and named here so the difference is a decision rather than
   * an oversight: the first carries its own refusal when Web Crypto is absent,
   * and the second is a port that ships in its own chunk beside `shortHash`
   * and `hmacSha256Hex`.
   */
  it("declares one hex SHA-256 over bytes", () => {
    expect(declaring(/^(?:export )?async function sha256Hex\(bytes: Uint8Array\)/mu)).toEqual(["core/bytes.ts"]);
    expect(declaring(/^(?:export )?async function sha256Hex\(/mu).filter((file) => file !== "core/bytes.ts"))
      .toEqual(["inference/providers/openai-compatible-provider.ts", "prime/ai/hash.ts"]);
  });

});
