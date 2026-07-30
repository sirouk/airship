/** The shape every identity in this build must have. Exported so tests assert this
 * reference rather than re-typing the regex: three subsystems had drifted to
 * `terminal-<epoch>-<Math.random>` and `<epoch>-<Math.random>` ID shapes that no
 * copied-literal test could have caught. */
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** RFC 4122 UUIDv4 from Web Crypto, including non-secure LAN contexts where
 * browsers expose getRandomValues but intentionally omit randomUUID. */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
