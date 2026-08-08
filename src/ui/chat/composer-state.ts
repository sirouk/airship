import type { AttachmentPart, MessagePart, TextPart } from "./message-parts";

/**
 * How many attachments one turn may carry, and the only ceiling this module owns.
 *
 * There was a second constant here — a 20 MiB `COMPOSER_ATTACHMENT_BYTE_LIMIT`
 * — that nothing anywhere read, and it disagreed with the size a person is
 * actually held to: `prepareCanonicalImageInputs` refuses any image over
 * `MAX_CANONICAL_IMAGE_BYTES` (10 MiB) in `core/multimodal.ts`. A declared
 * ceiling that never fires and states the wrong number is worse than none, so
 * the byte contract is read from the module that enforces it.
 */
export const COMPOSER_ATTACHMENT_LIMIT = 8;

export type ComposerAttachment = Readonly<{
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** Page-memory object URL used only for visual confirmation in this tab. */
  previewUrl?: string;
  /** Page-memory-only handle. Canonical bytes are created immediately before the durable turn. */
  file: File;
}>;

export function composerAttachments(files: readonly File[], id: () => string, preview?: (file: File) => string | undefined): readonly ComposerAttachment[] {
  return Object.freeze(files.slice(0, COMPOSER_ATTACHMENT_LIMIT).map((file) => {
    const previewUrl = preview?.(file);
    return Object.freeze({
      id: id(),
      name: boundedName(file.name || "Pasted attachment"),
      mediaType: file.type || "application/octet-stream",
      size: file.size,
      ...(previewUrl ? { previewUrl } : {}),
      file,
    });
  }));
}

/** Public projection for an image that was included in the canonical inference request. */
export function userMessageParts(content: string, attachments: readonly ComposerAttachment[]): readonly MessagePart[] {
  const text: TextPart = Object.freeze({ id: "prompt", kind: "text", sequence: 0, endSequence: 0, sourceFactIds: Object.freeze(["prompt"]), content });
  const attachmentParts: AttachmentPart[] = attachments.map((item, index) => Object.freeze({
    id: `attachment-${item.id}`,
    kind: "attachment" as const,
    sequence: index + 1,
    endSequence: index + 1,
    sourceFactIds: Object.freeze([`attachment-${item.id}`]),
    attachmentId: item.id,
    name: item.name,
    mediaType: item.mediaType,
    sizeBytes: item.size,
    ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
    summary: "Included as an inline image inside the encrypted inference request.",
    reference: "inline-e2ee",
    status: "available" as const,
  }));
  return Object.freeze([text, ...attachmentParts]);
}

function boundedName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 256) || "Attachment";
}
