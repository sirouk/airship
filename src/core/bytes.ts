/** Return an owned ArrayBuffer accepted by strict Web Crypto and Fetch typings. */
export function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

/**
 * The one byte vocabulary this product speaks.
 *
 * Eight modules formatted bytes on their own and two of them disagreed about
 * what the units are called: `navigator.storage.estimate()` returning
 * 268,435,456 read "Origin storage 256 MB" on #capabilities and "256 MiB" two
 * taps away on #vault — one number, two names, no way for a reader to know it
 * was one number. The binary prefix wins because the divisor is 1024: labelling
 * a 1024-divided figure "MB" is arithmetically a lie, and four of the eight
 * copies already spelled it MiB.
 *
 * The rounding rule (whole numbers at ten and above, one decimal below) is kept
 * from the vault copy so a reader never sees "256.0 MiB" beside "256 MiB".
 *
 * "Unknown" is a formatting fallback, not a measurement claim. A surface that
 * knows *why* a number is missing must say so itself — see
 * `measuredBytesLabel` in src/capabilities/runtime-load.ts, which owns the
 * sentence "Not measurable in this browser" and never reaches this function
 * with an unmeasured value.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1024) return `${Math.floor(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let amount = value / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

/**
 * Lowercase hex SHA-256 of these bytes.
 *
 * One question with two callers that both need the *hex* spelling rather than
 * `core/hash.ts`'s `sha256:` base64url form: AWS SigV4 canonical requests and
 * the Walrus blob transport's integrity header both name it in hex because
 * their wire formats do. It lives here beside `ownedArrayBuffer`, which both
 * callers already import, so sharing it adds no import edge that was not there.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}
