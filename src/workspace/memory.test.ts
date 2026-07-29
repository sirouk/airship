import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes, workspaceContentByteLength } from "./content-codec";
import { workspaceEntryByteLength } from "./contracts";
import { MemoryWorkspace } from "./memory";

/**
 * Binary files cross the string-valued WorkspacePort inside a base64 envelope,
 * so a workspace that only recorded the stored length told the Explorer and the
 * editor strip that every image was a third larger than `read_file`/`stat_path`
 * reported for the same path. Both numbers now come from the same decode.
 */
describe("workspace file byte lengths", () => {
  it("reports a binary file's own bytes rather than its base64 envelope", async () => {
    const workspace = new MemoryWorkspace();
    // 96 KiB of bytes that are not valid UTF-8, so the codec has to envelope them.
    const bytes = Uint8Array.from({ length: 96 * 1024 }, (_value, index) => (index % 2 === 0 ? 0x00 : 0xff));
    const envelope = encodeWorkspaceBytes(bytes);

    const written = await workspace.write("/workspace/image.png", envelope);
    const [entry] = await workspace.list("/workspace");

    expect(written.size).toBeGreaterThan(98_304);
    expect(workspaceEntryByteLength(written)).toBe(98_304);
    expect(workspaceEntryByteLength(entry!)).toBe(98_304);
    // The exact number `read_file` puts in its binary metadata.
    expect(workspaceEntryByteLength(written)).toBe(workspaceContentByteLength(written.content));
  });

  it("leaves text files measuring exactly what storage holds", async () => {
    const workspace = new MemoryWorkspace();
    const written = await workspace.write("/workspace/notes.md", "héllo");
    expect(written.size).toBe(6);
    expect(workspaceEntryByteLength(written)).toBe(6);
  });

  it("falls back to the stored size for entries written before the decoded length existed", () => {
    // Records already in IndexedDB or a sealed manifest carry no decoded
    // length. Falling back is exactly as wrong as the old behaviour for those,
    // and right for the text files that are most of any workspace.
    expect(workspaceEntryByteLength({ size: 4_096 })).toBe(4_096);
  });

  it("is recorded by every persistent port, not only the one this suite can run", () => {
    // IndexedDB has no test double in this environment, so hold its writer to
    // the same contract at the source rather than letting it drift silently.
    for (const port of ["src/workspace/indexeddb.ts", "src/workspace/memory.ts", "src/vault/encrypted-workspace.ts"]) {
      expect(readFileSync(port, "utf8")).toContain("contentByteLength: workspaceContentByteLength(content)");
    }
  });
});
