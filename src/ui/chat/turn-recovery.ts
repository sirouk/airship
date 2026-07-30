import type { RequestFailureKind } from "../request-state";
import type { ErrorPart, FooterPart, MessagePart, TextPart } from "./message-parts";

/**
 * The cause a failed turn ends on, in the failure vocabulary the product owns.
 *
 * Every non-cancelled failure closed with "Connection lost — partial response
 * kept.", including every failure that happened over a working connection: a
 * provider 500, a rejected E2EE nonce, a failed attestation, a rate limit, a
 * spent balance. Measured on a live HTTP 429 on a phone whose connection was
 * fine (`docs/design-review/journey-complaints.md`), where the transport's own
 * card said 429 and this footer, the last sentence under the answer, answered
 * it with the one cause that had not happened.
 *
 * The keys are `request-state`'s `RequestFailureKind` rather than a second
 * vocabulary invented here, and the record is exhaustive over it so adding a
 * kind there fails to compile here instead of silently resolving to a guess.
 * The import is type-only: `request-state` is loaded on demand at the failure
 * site and must not be pulled into the shell's chunk by this module.
 */
const FAILURE_CAUSE: Readonly<Record<RequestFailureKind, string>> = Object.freeze({
  offline: "Connection lost",
  unreachable: "Provider unreachable",
  credential: "Access rejected",
  "rate-limit": "Rate limit reached",
  billing: "Out of credit",
  provider: "Provider failed",
  unknown: "Turn failed",
});

/**
 * The one sentence both reporters of a stop use, so the error part and the
 * footer beneath it cannot drift into describing the same stop differently.
 */
export function turnRecoverySummary(stopped: boolean, failure?: RequestFailureKind): string {
  if (stopped) return "Stopped — partial response kept.";
  return `${FAILURE_CAUSE[failure ?? unclassifiedCause()]} — partial response kept.`;
}

/**
 * What an unclassified failure is allowed to claim.
 *
 * A caller that has not run the failure through `mapRequestFailure` still
 * leaves the footer one checkable fact — the very one the old sentence asserted
 * without ever checking it. `false` is decisive: the device really did lose the
 * network, so "Connection lost" is kept for the case it was always right about.
 * `true` proves nothing about a request that never completed, so it degrades to
 * the cause-free sentence rather than trading one guess for another.
 */
function unclassifiedCause(): RequestFailureKind {
  return typeof navigator === "object" && navigator.onLine === false ? "offline" : "unknown";
}

export function recoverPartialTurn(
  parts: readonly MessagePart[],
  streamed: string,
  pending: string,
  stopped: boolean,
  failure?: RequestFailureKind,
): readonly MessagePart[] {
  const next = parts.slice();
  const partial = `${streamed}${pending}`;
  if (partial) {
    const text: TextPart = Object.freeze({ id: "partial-stream", kind: "text", sequence: Number.MAX_SAFE_INTEGER - 2, endSequence: Number.MAX_SAFE_INTEGER - 2, sourceFactIds: Object.freeze(["partial-stream"]), content: partial });
    next.push(text);
  }
  const summary = turnRecoverySummary(stopped, failure);
  // Two independent reporters write into one list: the durable reducer, which
  // projects `turn.cancelled`/`turn.failed` into an error part, and this
  // helper. When the durable record has already landed, adding a second error
  // part reports the same stop twice in the same message. The footer is still
  // added, because only this path states that the partial text above it was
  // kept.
  const durable = parts.some((part) =>
    part.kind === "error" && (part.code === "turn.cancelled" || part.code === "turn.failed"));
  const footer: FooterPart = Object.freeze({ id: "turn-recovery-footer", kind: "footer", sequence: Number.MAX_SAFE_INTEGER, endSequence: Number.MAX_SAFE_INTEGER, sourceFactIds: Object.freeze(["turn-recovery-footer"]), summary });
  if (!durable) {
    const error: ErrorPart = Object.freeze({ id: "turn-recovery", kind: "error", sequence: Number.MAX_SAFE_INTEGER - 1, endSequence: Number.MAX_SAFE_INTEGER - 1, sourceFactIds: Object.freeze(["turn-recovery"]), summary, retryable: true });
    next.push(error);
  }
  next.push(footer);
  return Object.freeze(next);
}
