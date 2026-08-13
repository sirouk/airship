import { normalizeWorkspacePath } from "../workspace/contracts";

/**
 * What came back, and how the agent can hold it.
 *
 * `fetch_url` used to refuse a body whose `Content-Type` was not on a short
 * allowlist. That cost real answers to real requests: DuckDuckGo's
 * instant-answer API returns JSON under the legacy `application/x-javascript`
 * label, and the reader discarded a 200 that had the payload in it. The header
 * was wrong; the bytes were fine. An allowlist cannot tell those apart, because
 * it never looks at the bytes.
 *
 * So the type header is a hint and the bytes are the authority. Anything that
 * decodes as text is delivered as text whatever it was labelled; anything that
 * does not is delivered as bytes rather than refused. The agent decides what a
 * PDF or a zip or a PNG is for — this layer's only job is to hand it over
 * intact and say honestly which of the two it is.
 */
export type FetchBodyKind = "text" | "binary";

const TEXTUAL_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-ndjson",
  "application/graphql",
  "application/x-www-form-urlencoded",
  "application/sql",
  "application/yaml",
  "application/x-yaml",
  "application/csv",
  "application/rtf",
  "image/svg+xml",
]);

/**
 * A declared type that is textual beyond argument. Kept as a fast path and as
 * the tie-breaker for an empty body, never as a gate: a type that is missing
 * from this set says nothing, and the sniff decides.
 */
export function isTextualContentType(contentType: string): boolean {
  const essence = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence.startsWith("text/")
    || TEXTUAL_TYPES.has(essence)
    || essence.endsWith("+json")
    || essence.endsWith("+xml")
    || essence.endsWith("+yaml");
}

/**
 * Whether these bytes read as text.
 *
 * Strict UTF-8 first, because a body that fails a fatal decode is not text in
 * any encoding this reader can hand to a model. Then two structural rules that
 * separate text from binary far more reliably than any header: a NUL byte
 * appears in essentially no text and in almost every binary container, and
 * text does not carry a meaningful density of other C0 control bytes.
 *
 * UTF-16 and legacy single-byte encodings deliberately land in `binary`. They
 * are readable in principle, but guessing an encoding produces confident
 * mojibake, and the byte path preserves them losslessly for an agent that
 * knows better than this function does.
 */
export function looksTextual(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // Sample the head rather than the whole body: this runs on up to 8 MiB, and
  // a binary container that is clean UTF-8 for its first 64 KiB does not exist
  // in practice — magic numbers and headers are at the front.
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1_024));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Tab, newline, carriage return and form feed are ordinary in text.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) controls += 1;
  }
  return controls / sample.length < 0.01;
}

/**
 * The disposition of one body. Nothing is ever refused here — the return type
 * has no third case for "unsupported", on purpose.
 */
export function fetchBodyKind(contentType: string, bytes: Uint8Array): FetchBodyKind {
  if (bytes.byteLength === 0) return "text";
  // The header can only promote a body that already reads as text; it can
  // never demote one, which is the whole point. `application/octet-stream`
  // over readable JSON is as common as JSON over `x-javascript`.
  if (looksTextual(bytes)) return "text";
  return isTextualContentType(contentType) && bytes.byteLength < 4 ? "text" : "binary";
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const EXTENSION_BY_TYPE = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["application/zip", "zip"],
  ["application/gzip", "gz"],
  ["application/x-tar", "tar"],
  ["application/wasm", "wasm"],
  ["application/epub+zip", "epub"],
  ["application/octet-stream", "bin"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["font/woff2", "woff2"],
  ["font/woff", "woff"],
  ["font/ttf", "ttf"],
]);

/**
 * Where a body that cannot be read as text is put.
 *
 * Bytes have to land somewhere to survive the call: base64 in a tool result is
 * a third larger than the object and is charged to the context window, so an
 * 8 MiB download would cost more than any answer it could support. The
 * workspace is the cheap carrier — the agent already reads, executes over, and
 * shows files there — so a binary answer becomes a path, and only an explicit
 * `as: "base64"` ever inlines one.
 *
 * The directory is fixed so downloads are findable and never collide with the
 * repository the agent is working in. The name comes from the URL, so a second
 * fetch of the same address overwrites rather than accumulating a numbered pile
 * — a fetch is a read, and reading twice should not grow the workspace.
 */
export const FETCH_DOWNLOAD_DIRECTORY = "/workspace/.airship/downloads";

export function downloadPathFor(url: URL, contentType: string): string {
  const essence = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const base = sanitizeSegment(decodeSafely(segment)) || sanitizeSegment(url.hostname) || "download";
  const extension = EXTENSION_BY_TYPE.get(essence);
  const named = extension && !base.toLowerCase().endsWith(`.${extension}`) ? `${base}.${extension}` : base;
  // A query string distinguishes two different objects behind one path, so it
  // has to reach the name — hashed, because it is arbitrary length and
  // arbitrary bytes and a file name is neither.
  const query = url.search ? `-${fingerprint(url.search)}` : "";
  const dotted = named.lastIndexOf(".");
  const withQuery = query && dotted > 0
    ? `${named.slice(0, dotted)}${query}${named.slice(dotted)}`
    : `${named}${query}`;
  return normalizeWorkspacePath(`${FETCH_DOWNLOAD_DIRECTORY}/${withQuery.slice(0, 120)}`);
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[-.]+/u, "").replace(/[-.]+$/u, "");
}

/** Short, stable, and not a security claim — only a name that distinguishes. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}
