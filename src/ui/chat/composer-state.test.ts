import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composerAttachments, userMessageParts, COMPOSER_ATTACHMENT_LIMIT } from "./composer-state";

describe("composer attachments", () => {
  it("bounds page-memory file handles and marks sent images available", () => {
    const files = Array.from({ length: 20 }, (_, index) => new File(["x"], `f${index}.png`, { type: "image/png" }));
    const attachments = composerAttachments(files, () => crypto.randomUUID());
    expect(attachments).toHaveLength(COMPOSER_ATTACHMENT_LIMIT);
    const parts = userMessageParts("inspect", attachments);
    expect(attachments[0]?.file).toBe(files[0]);
    expect(parts[1]).toMatchObject({ kind: "attachment", status: "available", summary: expect.stringContaining("with this inference request") });
  });

  it("declares no byte ceiling of its own, because it enforces none", () => {
    /*
     * `COMPOSER_ATTACHMENT_BYTE_LIMIT = 20 MiB` was exported here and read by
     * nothing: `composerAttachments` and the composer's own file handler filter
     * on media type and on the count, never on size. The number a person is
     * actually refused at is `MAX_CANONICAL_IMAGE_BYTES` — 10 MiB per image, in
     * `core/multimodal-contract.ts`, checked when the turn is prepared. Two ceilings, one
     * of them inert and wrong, is how the composer came to promise a 14 MB photo
     * was "ready for inline vision inference".
     */
    const source = readFileSync(new URL("./composer-state.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/export const COMPOSER_ATTACHMENT_BYTE_LIMIT/u);
    expect(source).not.toMatch(/1024 \* 1024/u);
    // The count cap is real and is applied above.
    expect(source).toContain("export const COMPOSER_ATTACHMENT_LIMIT = 8;");
  });
});
