/**
 * Exact, deterministic contract for the unsigned Companion store archives.
 *
 * This module intentionally supports only the ZIP shape emitted below. The
 * release gate does not need a general archive extractor: rejecting encryption,
 * ZIP64, data descriptors, comments, extra fields, duplicate names and trailing
 * bytes keeps the artifact parser small and fail closed.
 */
import { TextDecoder } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const FIXED_DOS_DATE = 0x21;
const FIXED_DOS_TIME = 0;
const ZIP_FLAGS = 0x0800;
const ZIP_METHOD = 8;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_CONTENT_BYTES = 64 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const EXTENSION_PACKAGE_MEMBERS = Object.freeze([
  "background.js",
  "content-script.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
]);

export const EXTENSION_RELEASE_ARCHIVES = Object.freeze([
  Object.freeze({ target: "chromium", channel: "release", file: "airship-companion-chromium-release.zip" }),
  Object.freeze({ target: "firefox", channel: "release", file: "airship-companion-firefox-release.zip" }),
  Object.freeze({ target: "safari", channel: "release", file: "airship-companion-safari-release.zip" }),
  Object.freeze({ target: "chromium", channel: "development", file: "airship-companion-chromium-development.zip" }),
  Object.freeze({ target: "firefox", channel: "development", file: "airship-companion-firefox-development.zip" }),
  Object.freeze({ target: "safari", channel: "development", file: "airship-companion-safari-development.zip" }),
]);

export const EXTENSION_RELEASE_FILES = Object.freeze([
  "SHA256SUMS",
  ...EXTENSION_RELEASE_ARCHIVES.map(({ file }) => file).sort(compareText),
  "release.json",
]);

export function assertExactInventory(label, actualPaths, expectedPaths) {
  const counts = new Map();
  for (const path of actualPaths) counts.set(path, (counts.get(path) ?? 0) + 1);
  const actual = new Set(counts.keys());
  const expected = new Set(expectedPaths);
  const missing = [...expected].filter((path) => !actual.has(path)).sort(compareText);
  const unexpected = [...actual].filter((path) => !expected.has(path)).sort(compareText);
  const duplicates = [...counts]
    .filter(([, count]) => count !== 1)
    .map(([path]) => path)
    .sort(compareText);
  if (missing.length === 0 && unexpected.length === 0 && duplicates.length === 0) return;
  const details = [];
  if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) details.push(`unexpected: ${unexpected.join(", ")}`);
  if (duplicates.length > 0) details.push(`duplicate: ${duplicates.join(", ")}`);
  throw new Error(`${label} inventory mismatch (${details.join("; ")}).`);
}

export function createExtensionArchive(entries) {
  assertExactInventory(
    "Companion package",
    entries.map(({ path }) => path),
    EXTENSION_PACKAGE_MEMBERS,
  );
  const byPath = new Map(entries.map(({ path, payload }) => [path, Buffer.from(payload)]));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of EXTENSION_PACKAGE_MEMBERS) {
    const nameBytes = Buffer.from(name, "utf8");
    const content = byPath.get(name);
    const compressed = deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_FLAGS, 6);
    local.writeUInt16LE(ZIP_METHOD, 8);
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
    central.writeUInt16LE(ZIP_FLAGS, 8);
    central.writeUInt16LE(ZIP_METHOD, 10);
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
  end.writeUInt16LE(EXTENSION_PACKAGE_MEMBERS.length, 8);
  end.writeUInt16LE(EXTENSION_PACKAGE_MEMBERS.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBytes, end]);
}

export function readExtensionArchive(label, bytes) {
  const archive = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const endOffset = archive.byteLength - 22;
  requireBytes(archive, endOffset, 22, label);
  requireValue(label, archive.readUInt32LE(endOffset), 0x06054b50, "end signature");
  requireValue(label, archive.readUInt16LE(endOffset + 4), 0, "end disk number");
  requireValue(label, archive.readUInt16LE(endOffset + 6), 0, "central-directory disk number");
  requireValue(
    label,
    archive.readUInt16LE(endOffset + 8),
    EXTENSION_PACKAGE_MEMBERS.length,
    "entries on disk",
  );
  requireValue(
    label,
    archive.readUInt16LE(endOffset + 10),
    EXTENSION_PACKAGE_MEMBERS.length,
    "total entries",
  );
  requireValue(label, archive.readUInt16LE(endOffset + 20), 0, "archive comment length");
  const centralBytes = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (centralOffset + centralBytes !== endOffset) {
    throw new Error(`${label} central directory is not the exact archive tail.`);
  }

  const entries = [];
  let centralCursor = centralOffset;
  let nextLocalOffset = 0;
  let totalContentBytes = 0;
  for (const expectedName of EXTENSION_PACKAGE_MEMBERS) {
    requireBytes(archive, centralCursor, 46, label);
    requireValue(label, archive.readUInt32LE(centralCursor), 0x02014b50, "central signature");
    requireValue(label, archive.readUInt16LE(centralCursor + 4), 20, "creator version");
    requireValue(label, archive.readUInt16LE(centralCursor + 6), 20, "extractor version");
    requireValue(label, archive.readUInt16LE(centralCursor + 8), ZIP_FLAGS, "central flags");
    requireValue(label, archive.readUInt16LE(centralCursor + 10), ZIP_METHOD, "central compression method");
    requireValue(label, archive.readUInt16LE(centralCursor + 12), FIXED_DOS_TIME, "central timestamp");
    requireValue(label, archive.readUInt16LE(centralCursor + 14), FIXED_DOS_DATE, "central date");
    const checksum = archive.readUInt32LE(centralCursor + 16);
    const compressedBytes = archive.readUInt32LE(centralCursor + 20);
    const contentBytes = archive.readUInt32LE(centralCursor + 24);
    const nameBytes = archive.readUInt16LE(centralCursor + 28);
    requireValue(label, archive.readUInt16LE(centralCursor + 30), 0, "central extra length");
    requireValue(label, archive.readUInt16LE(centralCursor + 32), 0, "central comment length");
    requireValue(label, archive.readUInt16LE(centralCursor + 34), 0, "entry disk number");
    requireValue(label, archive.readUInt16LE(centralCursor + 36), 0, "internal attributes");
    requireValue(label, archive.readUInt32LE(centralCursor + 38), 0, "external attributes");
    const localOffset = archive.readUInt32LE(centralCursor + 42);
    requireBytes(archive, centralCursor + 46, nameBytes, label);
    const name = decodeName(label, archive.subarray(centralCursor + 46, centralCursor + 46 + nameBytes));
    if (name !== expectedName) {
      throw new Error(`${label} member order/inventory differs at ${expectedName}.`);
    }
    centralCursor += 46 + nameBytes;

    if (contentBytes > MAX_MEMBER_BYTES) throw new Error(`${label} member ${name} is too large.`);
    totalContentBytes += contentBytes;
    if (totalContentBytes > MAX_ARCHIVE_CONTENT_BYTES) throw new Error(`${label} expands beyond its release limit.`);
    if (localOffset !== nextLocalOffset) throw new Error(`${label} has a gap, overlap or unlisted local record.`);
    requireBytes(archive, localOffset, 30, label);
    requireValue(label, archive.readUInt32LE(localOffset), 0x04034b50, "local signature");
    requireValue(label, archive.readUInt16LE(localOffset + 4), 20, "local extractor version");
    requireValue(label, archive.readUInt16LE(localOffset + 6), ZIP_FLAGS, "local flags");
    requireValue(label, archive.readUInt16LE(localOffset + 8), ZIP_METHOD, "local compression method");
    requireValue(label, archive.readUInt16LE(localOffset + 10), FIXED_DOS_TIME, "local timestamp");
    requireValue(label, archive.readUInt16LE(localOffset + 12), FIXED_DOS_DATE, "local date");
    requireValue(label, archive.readUInt32LE(localOffset + 14), checksum, "local checksum");
    requireValue(label, archive.readUInt32LE(localOffset + 18), compressedBytes, "local compressed size");
    requireValue(label, archive.readUInt32LE(localOffset + 22), contentBytes, "local content size");
    requireValue(label, archive.readUInt16LE(localOffset + 26), nameBytes, "local name length");
    requireValue(label, archive.readUInt16LE(localOffset + 28), 0, "local extra length");
    requireBytes(archive, localOffset + 30, nameBytes + compressedBytes, label);
    const localName = decodeName(label, archive.subarray(localOffset + 30, localOffset + 30 + nameBytes));
    if (localName !== name) throw new Error(`${label} local and central member names disagree.`);
    const payloadOffset = localOffset + 30 + nameBytes;
    const compressed = archive.subarray(payloadOffset, payloadOffset + compressedBytes);
    let payload;
    try {
      payload = inflateRawSync(compressed, { maxOutputLength: Math.max(contentBytes, 1) });
    } catch {
      throw new Error(`${label} member ${name} has invalid compressed data.`);
    }
    if (payload.byteLength !== contentBytes) throw new Error(`${label} member ${name} size does not match.`);
    if (crc32(payload) !== checksum) throw new Error(`${label} member ${name} checksum does not match.`);
    entries.push(Object.freeze({ path: name, payload }));
    nextLocalOffset = payloadOffset + compressedBytes;
  }
  if (centralCursor !== endOffset) throw new Error(`${label} central directory has unlisted data.`);
  if (nextLocalOffset !== centralOffset) throw new Error(`${label} local records do not end at the central directory.`);
  return Object.freeze(entries);
}

function decodeName(label, bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${label} contains a non-UTF-8 member name.`);
  }
}

function requireBytes(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > bytes.byteLength) {
    throw new Error(`${label} is truncated or has an out-of-range ZIP record.`);
  }
}

function requireValue(label, actual, expected, field) {
  if (actual !== expected) throw new Error(`${label} has an unsupported ${field}.`);
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
