/**
 * Build the Airship bridge for every browser that can host it.
 *
 * One source tree, three outputs. The manifest is produced by importing the
 * same `manifest.ts` the tests exercise, so a match pattern can never be
 * hand-edited into a manifest without the code that enforces it changing too.
 *
 *   node extension/build.mjs                       # release, all targets
 *   node extension/build.mjs --channel=development # adds the loopback origins
 *   node extension/build.mjs --target=firefox
 *   node extension/build.mjs --target=safari       # input to the Xcode wrapper
 *
 * Output is deliberately unminified: this is code a browser vendor's reviewer
 * and a suspicious user both have to be able to read.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export const TARGETS = Object.freeze(["chromium", "firefox", "safari"]);
export const CHANNELS = Object.freeze(["release", "development"]);

/**
 * esbuild syntax targets, at the oldest engine each manifest claims.
 *
 * Exported so `build.test.mjs` can hold these and the manifests' declared
 * minimums (`minimum_chrome_version`, `browser_specific_settings`) to the same
 * numbers: a bundle compiled for a newer engine than the manifest admits would
 * install and then fail to parse.
 */
export const SYNTAX_TARGETS = Object.freeze({
  chromium: ["chrome116"],
  firefox: ["firefox128"],
  safari: ["safari16.4"],
});

const ENTRIES = Object.freeze([
  Object.freeze({ input: "src/background.ts", output: "background.js" }),
  Object.freeze({ input: "src/content-script.ts", output: "content-script.js" }),
]);

/**
 * Things that must not appear in a shipped bundle. The extension holds no
 * tokens and writes nothing durable, so any storage API in the output is a
 * boundary violation rather than a style question.
 */
const FORBIDDEN_PATTERNS = Object.freeze([
  Object.freeze({ pattern: /localStorage|sessionStorage/u, why: "the extension stores nothing" }),
  Object.freeze({ pattern: /indexedDB/u, why: "the extension stores nothing" }),
  Object.freeze({ pattern: /\.storage\b/u, why: "the extension stores nothing" }),
  Object.freeze({ pattern: /\bcookies\b/u, why: "the extension never touches cookies" }),
  Object.freeze({ pattern: /console\s*\./u, why: "relayed traffic is never logged" }),
  Object.freeze({ pattern: /externally_connectable/u, why: "the bridge is postMessage-only" }),
]);

export function verifyBundle(name, source) {
  const findings = [];
  for (const { pattern, why } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) findings.push(`${name} contains ${pattern.source} (${why}).`);
  }
  return findings;
}

async function loadManifestModule(scratch) {
  const file = resolve(scratch, `manifest-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    entryPoints: [resolve(here, "src/manifest.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: ["node22"],
    outfile: file,
    logLevel: "silent",
  });
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(file, { force: true });
  }
}

export async function buildExtension(options) {
  const target = options.target;
  const channel = options.channel;
  if (!TARGETS.includes(target)) throw new TypeError(`Unknown target ${target}.`);
  if (!CHANNELS.includes(channel)) throw new TypeError(`Unknown channel ${channel}.`);
  const outDir = resolve(options.outDir ?? resolve(here, "build", channel, target));
  const scratch = resolve(outDir, "..");
  await mkdir(outDir, { recursive: true });

  const { buildManifest } = await loadManifestModule(scratch);
  const manifest = buildManifest(target, channel);
  await writeFile(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const artifacts = [];
  for (const entry of ENTRIES) {
    const outfile = resolve(outDir, entry.output);
    await build({
      entryPoints: [resolve(here, entry.input)],
      bundle: true,
      // Content scripts are classic scripts and a bundled worker needs no
      // module semantics, so one IIFE format serves every target.
      format: "iife",
      platform: "browser",
      target: SYNTAX_TARGETS[target],
      define: { __AIRSHIP_BRIDGE_CHANNEL__: JSON.stringify(channel) },
      minify: false,
      sourcemap: false,
      legalComments: "none",
      outfile,
      logLevel: "silent",
    });
    const source = await readFile(outfile, "utf8");
    const findings = verifyBundle(entry.output, source);
    if (findings.length > 0) {
      throw new Error(`Bundle verification failed:\n  ${findings.join("\n  ")}`);
    }
    artifacts.push(Object.freeze({
      file: entry.output,
      bytes: Buffer.byteLength(source, "utf8"),
      sha256: createHash("sha256").update(source).digest("hex"),
    }));
  }

  return Object.freeze({ target, channel, outDir, manifest, artifacts: Object.freeze(artifacts) });
}

function parseArgv(argv) {
  const options = { channel: "release", targets: [...TARGETS] };
  for (const argument of argv) {
    const [name, value] = argument.split("=");
    if (name === "--channel" && value) options.channel = value;
    else if (name === "--target" && value) options.targets = value.split(",");
    else throw new TypeError(`Unknown argument ${argument}.`);
  }
  return options;
}

async function main() {
  const options = parseArgv(process.argv.slice(2));
  for (const target of options.targets) {
    const result = await buildExtension({ target, channel: options.channel });
    const files = result.artifacts
      .map((artifact) => `${artifact.file} ${artifact.bytes} B ${artifact.sha256.slice(0, 12)}`)
      .join("\n    ");
    process.stdout.write(`${target}/${options.channel} -> ${result.outDir}\n    ${files}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
