import type { CanonicalImageInput } from "./contracts";
import {
  MAX_CANONICAL_IMAGES,
  MAX_CANONICAL_IMAGE_BYTES,
  MAX_CANONICAL_IMAGE_TOTAL_BYTES,
} from "./multimodal-contract";

const MEDIA_TYPE = /^image\/[a-z0-9][a-z0-9.+-]{0,126}$/u;
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
