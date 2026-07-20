import type { CanonicalImageInput, CanonicalMessage } from "./contracts";

export const MAX_CANONICAL_IMAGES = 8;
export const MAX_CANONICAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CANONICAL_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_INFERENCE_HISTORY_IMAGES = 2;

const MEDIA_TYPE = /^image\/[a-z0-9][a-z0-9.+-]{0,126}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const UNSAFE_NAME = /[\u0000-\u001f\u007f]/gu;

/** Convert browser-selected image files into bounded canonical transcript inputs. */
export async function prepareCanonicalImageInputs(
  files: readonly File[],
): Promise<readonly CanonicalImageInput[]> {
  if (files.length > MAX_CANONICAL_IMAGES) {
    throw new TypeError(`A turn may contain at most ${MAX_CANONICAL_IMAGES} images.`);
  }
  let total = 0;
  const images: CanonicalImageInput[] = [];
  for (const file of files) {
    if (!MEDIA_TYPE.test(file.type)) throw new TypeError(`${safeName(file.name)} is not an image.`);
    if (file.size <= 0 || file.size > MAX_CANONICAL_IMAGE_BYTES) {
      throw new TypeError(`${safeName(file.name)} exceeds the bounded image size contract.`);
    }
    total += file.size;
    if (total > MAX_CANONICAL_IMAGE_TOTAL_BYTES) {
      throw new TypeError("The combined image payload exceeds the 20 MiB turn limit.");
    }
    images.push(Object.freeze({
      type: "image",
      name: safeName(file.name),
      mediaType: file.type.toLowerCase(),
      dataUrl: await fileDataUrl(file),
      sizeBytes: file.size,
    }));
  }
  return Object.freeze(images);
}

/** Validate and clone image inputs before they enter a durable journal or provider payload. */
export function canonicalImageInputs(value: unknown): readonly CanonicalImageInput[] | undefined {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CANONICAL_IMAGES) return undefined;
  let total = 0;
  const result: CanonicalImageInput[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const image = candidate as Record<string, unknown>;
    if (
      image.type !== "image" ||
      typeof image.name !== "string" ||
      typeof image.mediaType !== "string" ||
      typeof image.dataUrl !== "string" ||
      !Number.isSafeInteger(image.sizeBytes)
    ) return undefined;
    const mediaType = image.mediaType.toLowerCase();
    const name = safeName(image.name);
    const sizeBytes = image.sizeBytes as number;
    if (!name || !MEDIA_TYPE.test(mediaType) || sizeBytes <= 0 || sizeBytes > MAX_CANONICAL_IMAGE_BYTES) {
      return undefined;
    }
    const prefix = `data:${mediaType};base64,`;
    if (!image.dataUrl.startsWith(prefix)) return undefined;
    const encoded = image.dataUrl.slice(prefix.length);
    const maxEncodedChars = Math.ceil(MAX_CANONICAL_IMAGE_BYTES / 3) * 4;
    if (
      !encoded ||
      encoded.length > maxEncodedChars ||
      !BASE64.test(encoded) ||
      decodedBase64Bytes(encoded) !== sizeBytes
    ) return undefined;
    total += sizeBytes;
    if (total > MAX_CANONICAL_IMAGE_TOTAL_BYTES) return undefined;
    result.push(Object.freeze({ type: "image", name, mediaType, dataUrl: image.dataUrl, sizeBytes }));
  }
  return Object.freeze(result);
}

/** Keep text history intact while limiting repeated inline image bytes to the newest images. */
export function boundInferenceHistoryImages(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  let remaining = MAX_INFERENCE_HISTORY_IMAGES;
  const bounded = new Array<CanonicalMessage>(messages.length);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!message.images?.length) {
      bounded[index] = message;
      continue;
    }
    const keep = message.images.slice(Math.max(0, message.images.length - remaining));
    remaining = Math.max(0, remaining - keep.length);
    if (keep.length) {
      bounded[index] = { ...message, images: keep };
    } else {
      const { images: _omitted, ...withoutImages } = message;
      bounded[index] = withoutImages;
    }
  }
  return bounded;
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function safeName(value: string): string {
  return value.replace(UNSAFE_NAME, "").trim().slice(0, 256) || "Image";
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${safeName(file.name)}.`));
    reader.readAsDataURL(file);
  });
}
