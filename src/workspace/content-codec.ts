const BINARY_PREFIX = "airship-git-binary-v1:";
const encoder = new TextEncoder();

/**
 * WorkspacePort is intentionally provider-neutral and string-valued. Opaque
 * bytes therefore cross that narrow boundary in one reversible envelope.
 * Every consumer that projects a workspace into a byte-capable filesystem
 * must use this codec; displaying or executing the envelope itself is a bug.
 */
export function encodeWorkspaceBytes(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0") && !text.startsWith(BINARY_PREFIX) && equalBytes(encoder.encode(text), bytes)) return text;
  } catch {
    // Opaque bytes use the reversible envelope below.
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `${BINARY_PREFIX}${btoa(binary)}`;
}

export function decodeWorkspaceBytes(content: string): Uint8Array {
  if (!isWorkspaceBinaryEnvelope(content)) return encoder.encode(content);
  const encoded = content.slice(BINARY_PREFIX.length);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("Workspace binary envelope is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function isWorkspaceBinaryEnvelope(content: string): boolean {
  return content.startsWith(BINARY_PREFIX);
}

/**
 * The file's own byte length, envelope decoded.
 *
 * Measured arithmetically rather than by decoding: every WorkspacePort now
 * records this on write, and a 16 MiB object must not be materialised a second
 * time just to be sized. `btoa` always emits padded quads, so the length of a
 * real envelope is exact.
 *
 * It also never throws. A plain text file may legitimately open with the
 * prefix, and refusing to save it would be a far worse failure than reporting
 * the stored length for something that was never a real envelope.
 */
export function workspaceContentByteLength(content: string): number {
  if (!isWorkspaceBinaryEnvelope(content)) return encoder.encode(content).byteLength;
  const encoded = content.length - BINARY_PREFIX.length;
  if (encoded === 0) return 0;
  if (encoded % 4 !== 0) return encoder.encode(content).byteLength;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (encoded / 4) * 3 - padding;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
