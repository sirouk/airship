/**
 * Build and package the reviewed Airship Companion source for each browser.
 *
 * The archives are deterministic: sorted file names, fixed timestamps, no
 * platform metadata. Store signatures are intentionally not fabricated here;
 * Chrome Web Store, Edge Add-ons, AMO and Apple sign after account review.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildExtension, CHANNELS, TARGETS } from "./build.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "public", "extension", "releases");
const FIXED_DOS_DATE = 0x21;
const FIXED_DOS_TIME = 0;

async function main() {
  await mkdir(releaseRoot, { recursive: true });
  const archives = [];
  let version;
  for (const channel of CHANNELS) {
    for (const target of TARGETS) {
      const result = await buildExtension({ target, channel });
      version ??= result.manifest.version;
      const name = `airship-companion-${target}-${channel}.zip`;
      const bytes = await zipDirectory(result.outDir);
      await writeFile(resolve(releaseRoot, name), bytes);
      archives.push(Object.freeze({
        target,
        channel,
        file: name,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        installable: target === "chromium"
          ? "unpacked"
          : target === "firefox"
            ? "temporary-until-amo-signed"
            : "safari-web-extension-packager-required",
      }));
    }
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
  process.stdout.write(
    `${archives.length} companion packages written to ${relative(root, releaseRoot)} (v${String(version)}).\n`,
  );
}

async function zipDirectory(directory) {
  const files = await walk(directory);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const absolute of files) {
    const name = relative(directory, absolute).replaceAll("\\", "/");
    const nameBytes = Buffer.from(name, "utf8");
    const content = await readFile(absolute);
    const compressed = deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(content.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + compressed.byteLength;
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBytes, end]);
}

async function walk(directory) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(absolute));
    else if (entry.isFile() && (await stat(absolute)).size >= 0) paths.push(absolute);
  }
  return paths.sort((left, right) => basename(left).localeCompare(basename(right)) || left.localeCompare(right));
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

await main();
