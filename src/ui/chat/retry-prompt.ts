import { messagePlainText, type MessagePart } from "./message-parts";

/**
 * The subset of an audited presentation row this module needs. Declared
 * structurally so the shell can recover retry prompts without pulling the
 * deferred session-presentation module into the entry chunk.
 */
export type RetryPromptRow = Readonly<{
  role: "user" | "assistant";
  turnId: string;
  parts: readonly MessagePart[];
}>;

/**
 * The prompt that produced the assistant row at `index`, as plain text.
 *
 * A resumed transcript carries no composer state, so without this the Retry
 * control can never render after a reload. Only the user row of the *same*
 * turn qualifies: pairing an assistant row with an unrelated earlier prompt
 * would make Retry silently re-ask a different question.
 *
 * Fail closed on attachments. A journal row records an attachment's name,
 * media type and size, never its bytes, and the composer `File` handle died
 * with the previous page. Recovering the text alone would let Retry re-send a
 * visibly different request than the one on screen — silently dropping the
 * user's image — so a turn that carried an attachment recovers no prompt at
 * all and the Retry control simply does not render for it.
 */
export function originatingPromptForRow(
  rows: readonly RetryPromptRow[],
  index: number,
): string | undefined {
  const row = rows[index];
  if (!row || row.role !== "assistant") return undefined;
  const previous = rows[index - 1];
  if (!previous || previous.role !== "user" || previous.turnId !== row.turnId) return undefined;
  if (previous.parts.some((part) => part.kind === "attachment")) return undefined;
  // messagePlainText is already bounded by MESSAGE_PART_DISPLAY_LIMITS, so a
  // pathological journal row cannot produce an unbounded resend payload.
  const prompt = messagePlainText(previous.parts).trim();
  return prompt.length > 0 ? prompt : undefined;
}
