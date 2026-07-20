import { describe, expect, it } from "vitest";
import { composerAttachments, userMessageParts, COMPOSER_ATTACHMENT_LIMIT } from "./composer-state";

describe("composer attachments", () => {
  it("bounds page-memory file handles and marks sent images available", () => {
    const files = Array.from({ length: 20 }, (_, index) => new File(["x"], `f${index}.png`, { type: "image/png" }));
    const attachments = composerAttachments(files, () => crypto.randomUUID());
    expect(attachments).toHaveLength(COMPOSER_ATTACHMENT_LIMIT);
    const parts = userMessageParts("inspect", attachments);
    expect(attachments[0]?.file).toBe(files[0]);
    expect(parts[1]).toMatchObject({ kind: "attachment", status: "available", summary: expect.stringContaining("encrypted inference") });
  });
});
