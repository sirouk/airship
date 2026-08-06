/**
 * Port of prime-agent packages/ai/src/utils/sanitize-unicode.ts.
 * Removes unpaired Unicode surrogates, which break JSON serialization on
 * several providers. Properly paired characters (emoji outside the BMP) are
 * preserved.
 */
export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
