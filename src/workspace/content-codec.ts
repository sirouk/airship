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

export function workspaceContentByteLength(content: string): number {
  return decodeWorkspaceBytes(content).byteLength;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
