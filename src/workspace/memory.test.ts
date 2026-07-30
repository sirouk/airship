import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes, workspaceContentByteLength } from "./content-codec";
import { workspaceEntryByteLength } from "./contracts";
import { MemoryWorkspace } from "./memory";

/**
 * Binary files cross the string-valued WorkspacePort inside a base64 envelope,
 * so a workspace that only recorded the stored length told the Explorer and the
 * editor strip that every image was a third larger than `read_file`/`stat_path`
 * reported for the same path. Both numbers now come from the same decode.
 *
 * That every port records it — including the two Node cannot host natively —
 * is proved by running them in `persistent-ports.test.ts`. This file keeps only
 * what that table does not say.
 */
describe("workspace file byte lengths", () => {
  it("records the exact number the agent's own tools compute for the same content", async () => {
    // `read_file` and `stat_path` size a binary with `workspaceContentByteLength`
    // at call time; the port sizes it once at write time. Two numbers for one
    // file in one transcript is the defect, so the two derivations are pinned
    // to each other rather than each to a literal.
    const workspace = new MemoryWorkspace();
    const envelope = encodeWorkspaceBytes(Uint8Array.from({ length: 4_097 }, (_value, index) => index % 251));

    const written = await workspace.write("/workspace/image.png", envelope);

    expect(workspaceEntryByteLength(written)).toBe(workspaceContentByteLength(written.content));
    expect(workspaceEntryByteLength(written)).toBe(4_097);
  });

  it("falls back to the stored size for entries written before the decoded length existed", () => {
    // Records already in IndexedDB or a sealed manifest carry no decoded
    // length. Falling back is exactly as wrong as the old behaviour for those,
    // and right for the text files that are most of any workspace.
    expect(workspaceEntryByteLength({ size: 4_096 })).toBe(4_096);
  });
});
