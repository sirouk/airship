/**
 * A non-empty field bounded by its UTF-8 byte length.
 *
 * One question — "is this a value an encrypted vault record may carry?" —
 * asked by both encrypted vault records, and written out twice, byte for byte,
 * in `reclamation-queue.ts` and `encrypted-workspace.ts`. The bound is bytes
 * rather than characters because what these records must not exceed is what
 * they cost on the wire and at rest: 512 characters of astral emoji is 2 KiB.
 */
export function requiredVaultString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  ) throw new Error(`${label} is invalid.`);
  return value;
}

const encoder = new TextEncoder();
