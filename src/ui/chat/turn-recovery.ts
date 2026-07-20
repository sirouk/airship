import type { ErrorPart, FooterPart, MessagePart, TextPart } from "./message-parts";

export function recoverPartialTurn(
  parts: readonly MessagePart[],
  streamed: string,
  pending: string,
  stopped: boolean,
): readonly MessagePart[] {
  const next = parts.slice();
  const partial = `${streamed}${pending}`;
  if (partial) {
    const text: TextPart = Object.freeze({ id: "partial-stream", kind: "text", sequence: Number.MAX_SAFE_INTEGER - 2, endSequence: Number.MAX_SAFE_INTEGER - 2, sourceFactIds: Object.freeze(["partial-stream"]), content: partial });
    next.push(text);
  }
  const summary = stopped ? "Stopped — partial response kept." : "Connection lost — partial response kept.";
  const error: ErrorPart = Object.freeze({ id: "turn-recovery", kind: "error", sequence: Number.MAX_SAFE_INTEGER - 1, endSequence: Number.MAX_SAFE_INTEGER - 1, sourceFactIds: Object.freeze(["turn-recovery"]), summary, retryable: true });
  const footer: FooterPart = Object.freeze({ id: "turn-recovery-footer", kind: "footer", sequence: Number.MAX_SAFE_INTEGER, endSequence: Number.MAX_SAFE_INTEGER, sourceFactIds: Object.freeze(["turn-recovery-footer"]), summary });
  next.push(error, footer);
  return Object.freeze(next);
}
