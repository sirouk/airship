import type { JsonValue } from "./contracts";
import { ownedArrayBuffer } from "./bytes";

const encoder = new TextEncoder();

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  /*
   * Code-unit order, not `localeCompare`. These strings are digest preimages
   * that cross devices — an evidence checkpoint written on one machine is
   * recomputed and enforced on the next — and ICU collation is a function of
   * the host's locale and ICU version, not of the bytes. Under `en` it orders
   * `a_b` before `a0b`; by code point it is the other way round, so a record
   * whose keys straddle that pair verified on the device that wrote it and
   * failed everywhere else. Code-unit order is also what RFC 8785 canonical
   * JSON specifies, so the preimage is now something another implementation
   * could reproduce.
   */
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return `sha256:${toBase64Url(new Uint8Array(digest))}`;
}

/**
 * The identity a tool approval ticket is bound to, and the product's only
 * definition of "the same call".
 *
 * It lives beside the primitives rather than in the registry because both the
 * broker that enforces it and the turn loop that detects repeats need it, and a
 * second, independently-written notion of sameness would drift until repeat
 * detection either never fired or fired on calls the broker considers distinct.
 * It is here rather than in `tools/registry` so `core/` does not take a runtime
 * dependency on `tools/` — that import splits the bundle graph.
 */
export function toolArgumentsDigest(argumentsValue: JsonValue): Promise<string> {
  return sha256(stableStringify(argumentsValue));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
