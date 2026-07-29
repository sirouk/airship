import { describe, expect, it } from "vitest";
import {
  decodeWorkspaceBytes,
  encodeWorkspaceBytes,
  workspaceContentByteLength,
} from "./content-codec";

describe("workspace content sizing", () => {
  it("matches the decoded length exactly at every base64 padding", async () => {
    // Every port now sizes each write with this, so an arithmetic shortcut has
    // to agree with a real decode for all three quad remainders.
    for (const length of [0, 1, 2, 3, 4, 5, 6, 4_096, 4_097]) {
      const bytes = Uint8Array.from({ length }, (_value, index) => (index % 2 === 0 ? 0x00 : 0xff));
      const envelope = encodeWorkspaceBytes(bytes);
      expect(workspaceContentByteLength(envelope)).toBe(decodeWorkspaceBytes(envelope).byteLength);
      expect(workspaceContentByteLength(envelope)).toBe(length);
    }
  });

  it("sizes ordinary text as the bytes it stores", () => {
    expect(workspaceContentByteLength("héllo")).toBe(6);
    expect(workspaceContentByteLength("")).toBe(0);
  });

  it("never refuses to size a text file that merely opens with the envelope prefix", () => {
    // A save must not fail because a person's notes start with the marker
    // string. Sizing degrades to the stored length; only the decoders, which
    // are the ones that actually need the bytes, still reject it.
    const impostor = "airship-git-binary-v1:not really base64!";
    expect(() => workspaceContentByteLength(impostor)).not.toThrow();
    expect(workspaceContentByteLength(impostor)).toBe(new TextEncoder().encode(impostor).byteLength);
    expect(() => decodeWorkspaceBytes(impostor)).toThrow("not valid base64");
  });
});
