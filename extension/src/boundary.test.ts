import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const sources = readdirSync(here)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => Object.freeze({ name, text: readFileSync(join(here, name), "utf8") }));

/**
 * Rule 5 of the bridge contract is "no credential storage", and rule 3 is
 * `credentials: "omit"`. Both are properties of the whole source tree rather
 * than of any one function, so they are asserted over the tree.
 */
const FORBIDDEN = Object.freeze([
  Object.freeze({ pattern: /\blocalStorage\b/u, why: "the extension writes nothing durable" }),
  Object.freeze({ pattern: /\bsessionStorage\b/u, why: "the extension writes nothing durable" }),
  Object.freeze({ pattern: /\bindexedDB\b/u, why: "the extension writes nothing durable" }),
  Object.freeze({ pattern: /\.storage\b/u, why: "the extension uses no extension storage area" }),
  Object.freeze({ pattern: /\.cookies\b/u, why: "the extension never reads cookies" }),
  Object.freeze({ pattern: /\bconsole\s*\./u, why: "relayed traffic is never logged" }),
  Object.freeze({ pattern: /\beval\s*\(/u, why: "no dynamic code" }),
  Object.freeze({ pattern: /new\s+Function\s*\(/u, why: "no dynamic code" }),
  Object.freeze({ pattern: /credentials:\s*"(?:include|same-origin)"/u, why: "requests are credential-free" }),
  Object.freeze({ pattern: /postMessage\([^)]*"\*"/u, why: "replies go to an exact origin" }),
]);

describe("extension source boundary", () => {
  it("scans a source tree that is actually there", () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      "background.ts",
      "content-bridge.ts",
      "content-script.ts",
      "manifest.ts",
      "policy.ts",
      "protocol.ts",
      "relay.ts",
      "user-agent.ts",
      "webextension.ts",
    ]);
  });

  it("contains no storage, logging, dynamic-code or credential-bearing call anywhere", () => {
    const violations: string[] = [];
    for (const source of sources) {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(source.text)) violations.push(`${source.name}: ${pattern.source} (${why})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the one credential-free fetch shape in the relay", () => {
    const relay = sources.find((source) => source.name === "relay.ts")?.text ?? "";
    expect(relay).toContain("credentials: \"omit\"");
    expect(relay).toContain("redirect: \"manual\"");
    expect((relay.match(/fetchImpl\(/gu) ?? []).length).toBe(1);
  });
});
