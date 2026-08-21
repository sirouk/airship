/**
 * Derive a useful conversation title without contacting an inference provider.
 *
 * Naming is presentation, not part of a turn. It must not spend quota, delay a
 * prompt, or create a hidden provider request. NFKC and control stripping keep
 * the title inside the journal's printable-text boundary.
 */
export function conversationTitleFromPrompt(prompt: string): string {
  const normalized = prompt
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const maximum = 64;
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}
