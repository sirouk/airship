/**
 * Build and package the reviewed Airship Companion source for each browser.
 *
 * The archives are deterministic: exact sorted file names, fixed timestamps,
 * no platform metadata. Store signatures are intentionally not fabricated here;
 * Chrome Web Store, Edge Add-ons, AMO and Apple sign after account review.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { buildExtension } from "./build.mjs";
import {
  EXTENSION_PACKAGE_MEMBERS,
  EXTENSION_RELEASE_ARCHIVES,
  EXTENSION_RELEASE_FILES,
  assertExactInventory,
  createExtensionArchive,
} from "./release-archive.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "public", "extension", "releases");

async function main() {
  // Both trees are generated. Never let a prior run contribute an artifact.
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });
  const archives = [];
  let version;
  for (const { target, channel, file } of EXTENSION_RELEASE_ARCHIVES) {
    const result = await buildExtension({ target, channel });
    version ??= result.manifest.version;
    const bytes = await zipDirectory(result.outDir);
    await writeFile(resolve(releaseRoot, file), bytes);
    archives.push(Object.freeze({
      target,
      channel,
      file,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      installable: target === "chromium"
        ? "unpacked"
        : target === "firefox"
          ? "temporary-until-amo-signed"
          : "safari-web-extension-packager-required",
    }));
  }
  const metadata = Object.freeze({
    schema: "airship-companion-release:1",
    version,
    stores: Object.freeze({
      chrome: "awaiting-developer-account-publication",
      edge: "awaiting-developer-account-publication",
      firefox: "awaiting-amo-signing",
      safari: "awaiting-apple-packaging-signing-and-review",
    }),
    artifacts: Object.freeze(archives),
  });
  await writeFile(resolve(releaseRoot, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(
    resolve(releaseRoot, "SHA256SUMS"),
    `${archives.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n")}\n`,
    "utf8",
  );
  assertExactInventory(
    "Companion release directory",
    await collectRegularFiles(releaseRoot),
    EXTENSION_RELEASE_FILES,
  );
  process.stdout.write(
    `${archives.length} companion packages written to ${relative(root, releaseRoot)} (v${String(version)}).\n`,
  );
}

async function zipDirectory(directory) {
  const paths = await collectRegularFiles(directory);
  assertExactInventory("Companion package", paths, EXTENSION_PACKAGE_MEMBERS);
  const entries = await Promise.all(EXTENSION_PACKAGE_MEMBERS.map(async (path) => Object.freeze({
    path,
    payload: await readFile(resolve(directory, path)),
  })));
  return createExtensionArchive(entries);
}

async function collectRegularFiles(directory, base = directory) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`Companion output contains a symbolic link: ${toPosix(base, absolute)}.`);
    }
    if (info.isDirectory()) paths.push(...await collectRegularFiles(absolute, base));
    else if (info.isFile()) paths.push(toPosix(base, absolute));
    else throw new Error(`Companion output contains a non-file artifact: ${toPosix(base, absolute)}.`);
  }
  return paths.sort(compareText);
}

function toPosix(base, path) {
  return relative(base, path).replaceAll("\\", "/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

await main();
