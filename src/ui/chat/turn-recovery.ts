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
 *
 * `kept` is not decoration. "TURN FAILED — PARTIAL RESPONSE KEPT." was printed
 * over an empty region on three separate failure causes, because the text part
 * was pushed only `if (partial)` while the footer was appended unconditionally.
 * A footer is the last sentence under an answer; claiming something was kept
 * where nothing is visible teaches the reader that Airship's claims are
 * decorative. Nothing else in the vocabulary changes — a stop that did keep
 * words still says so.
 */
export function turnRecoverySummary(stopped: boolean, failure?: RequestFailureKind, kept = true): string {
  const cause = stopped ? "Stopped" : FAILURE_CAUSE[failure ?? unclassifiedCause()];
  return `${cause} — ${kept ? "partial response kept." : "nothing had arrived yet."}`;
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

/**
 * A local turn's failure, in words rather than in build output.
 *
 * Measured: activating a runtime from Capabilities put
 * "Failed to fetch dynamically imported module:
 * http://localhost:4173/assets/node-webcontainer-pack-DntNdFa_.js" into the
 * transcript under a FAILED TURN badge — a hashed build asset as the whole
 * diagnosis, with nothing said about what did not happen and no route back to
 * the page that offered the action. The browser's sentence names the file it
 * wanted; the person needs to know that nothing was installed, why this
 * usually happens, and what to press.
 *
 * Only this one class is translated. Every other thrown message is a sentence
 * the product wrote for a person and is passed through unchanged.
 */
export function readableLocalFailure(raw: string): string {
  const message = raw.trim();
  if (!/dynamically imported module|Importing a module script failed|error loading dynamically imported/iu.test(message)) {
    return message;
  }
  return "Airship could not download the code this command needs, so nothing was installed and no workspace, runtime or journal state changed."
    + " This is usually a dropped connection, or a newer version of Airship deployed while this tab was open."
    + " Try the command again; if it fails the same way, reload the page and re-run it from Capabilities.";
}

export function recoverPartialTurn(
  parts: readonly MessagePart[],
  streamed: string,
  pending: string,
  stopped: boolean,
  failure?: RequestFailureKind,
  /**
   * Whether this failure leaves the person a working way forward.
   *
   * "Retry is available." was rendered on every failed turn while the controls
   * it referred to were greyed out, because only the success path stamped the
   * pre-turn boundary a retry forks at. The claim now travels with the fact.
   */
  retryable = true,
): readonly MessagePart[] {
  const next = parts.slice();
  const partial = `${streamed}${pending}`;
  if (partial) {
    const text: TextPart = Object.freeze({ id: "partial-stream", kind: "text", sequence: Number.MAX_SAFE_INTEGER - 2, endSequence: Number.MAX_SAFE_INTEGER - 2, sourceFactIds: Object.freeze(["partial-stream"]), content: partial });
    next.push(text);
  }
  // What the footer is allowed to say was kept: this call's own partial, or
  // text the durable record already put in the card above it.
  const kept = Boolean(partial) || parts.some((part) => part.kind === "text" && part.content.trim().length > 0);
  const summary = turnRecoverySummary(stopped, failure, kept);
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
    const error: ErrorPart = Object.freeze({ id: "turn-recovery", kind: "error", sequence: Number.MAX_SAFE_INTEGER - 1, endSequence: Number.MAX_SAFE_INTEGER - 1, sourceFactIds: Object.freeze(["turn-recovery"]), summary, retryable });
    next.push(error);
  }
  next.push(footer);
  return Object.freeze(next);
}
