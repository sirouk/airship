import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import { EncryptedObjectWorkspace } from "../vault/encrypted-workspace";
import { encodeWorkspaceBytes } from "./content-codec";
import { workspaceEntryByteLength, type WorkspacePort } from "./contracts";
import { MemoryWorkspace } from "./memory";

const timestamp = "2026-07-18T12:00:00.000Z";
/** 96 KiB that is not valid UTF-8, so the codec has to envelope it. */
const BINARY = Uint8Array.from({ length: 96 * 1024 }, (_value, index) => (index % 2 === 0 ? 0x00 : 0xff));

/**
 * Every port a person's files can be mounted on, agreeing on one number.
 *
 * Binaries cross the string-valued WorkspacePort inside a base64 envelope, so a
 * port that records only the stored length tells the Explorer and the editor
 * strip that an image is a third larger than `read_file`/`stat_path` reports
 * for the same path. The defect is per-port, and its worst form is disagreement
 * between ports: the same workspace would size the same file differently
 * depending on whether it is held in memory or in the encrypted object-backed
 * vault. So the property is asserted against both production workspace ports.
 */
describe("workspace ports report a file's own byte length", () => {
  const ports: ReadonlyArray<Readonly<{ name: string; open: () => Promise<WorkspacePort> }>> = [
    { name: "MemoryWorkspace", open: async () => new MemoryWorkspace() },
    {
      name: "EncryptedObjectWorkspace",
      open: async () => new EncryptedObjectWorkspace(
        new MemoryObjectStore(),
        (await WorkspaceRootKey.generate()).key,
        "vault",
        () => timestamp,
        () => "revision-1",
      ),
    },
  ];

  for (const { name, open } of ports) {
    it(`records the decoded length on write and hands it back from list in ${name}`, async () => {
      const workspace = await open();
      const envelope = encodeWorkspaceBytes(BINARY);

      const written = await workspace.write("/workspace/image.png", envelope);
      // `list()` drops content, so an entry that did not carry the decoded
      // length would leave the Explorer with nothing but the envelope.
      const [entry] = await workspace.list("/workspace");

      expect(written.size).toBe(envelope.length);
      expect(written.size).toBeGreaterThan(BINARY.byteLength);
      expect(workspaceEntryByteLength(written)).toBe(BINARY.byteLength);
      expect(entry).toBeDefined();
      expect(workspaceEntryByteLength(entry!)).toBe(BINARY.byteLength);
      // The stored length stays exactly what storage holds: it bounds the
      // download and, in the vault, proves the sealed plaintext.
      expect(entry!.size).toBe(envelope.length);

      // Text — most of any workspace — must be untouched by the second
      // length: storage and display are the same bytes and must agree.
      const text = await workspace.write("/workspace/notes.md", "héllo");
      expect(text.size).toBe(6);
      expect(workspaceEntryByteLength(text)).toBe(6);
    });
  }
});
