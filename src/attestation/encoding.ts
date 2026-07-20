const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_PATTERN = /^[0-9a-f]+$/;

export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeCanonicalBase64(args: {
  value: string;
  label: string;
  minBytes?: number;
  maxBytes: number;
}): Uint8Array {
  const { value, label, minBytes = 0, maxBytes } = args;
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error(`${label} must be canonical standard base64`);
  }

  // Check the decoded-size upper bound before allocating through atob().
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength < minBytes || decodedLength > maxBytes) {
    throw new Error(`${label} decoded length is outside the allowed range`);
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== decodedLength || bytesToBase64(bytes) !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return bytes;
}

export function assertLowerHex(value: string, bytes: number, label: string): void {
  if (value.length !== bytes * 2 || !HEX_PATTERN.test(value)) {
    throw new Error(`${label} must be exactly ${bytes} bytes of lowercase hex`);
  }
}

export async function sha256Hex(
  value: string | Uint8Array,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !HEX_PATTERN.test(value)) throw new Error("invalid lowercase hex");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
