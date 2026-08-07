/**
 * Prime conversation naming — a byte-faithful mirror of the airship naming
 * path (`src/ui/app.tsx` `conversationTitleFromModel`,
 * `conversationTitleFromPrompt`, `usableConversationTitle`, and the
 * `CONVERSATION_NAMED_EVENT_TYPE` writers) for sessions the prime engine
 * settles.
 *
 * The canonical implementation lives in the UI layer, which `src/prime`
 * must never import (the same one-way dependency rule
 * `src/prime/transport-adapter.ts` documents), so the request construction,
 * the title reduction, the bounds and the journal shape are mirrored here
 * and pinned by colocated tests against the session audit
 * (`src/core/session-audit.ts`), the shared validator of both writers.
 *
 * What the parity actually is:
 *   - the naming request runs on the session's pinned airship transport
 *     (`InferenceTransport.stream`) with a fresh `naming-<uuid>` turn identity
 *     and `naming-request-<uuid>` operation identity — its own namespace,
 *     never the turn handler's per-request one;
 *   - the journaled record is `conversation.named` with payload
 *     `{ title?, answer, model, receipt? }`, plus a second `inference.usage`
 *     event under the same fresh identity carrying
 *     `{ inputTokens?, outputTokens?, source: "conversation-naming" }` — the
 *     usage/Infer-provider-receipt separation the audit's ancillary-inference
 *     admission is built on;
 *   - the answer is clamped as it accumulates (never after), the title
 *     reduction rejects refusals and essays, and the receipt is finalized
 *     against the exact request digest — recomputed from the record rather
 *     than trusted.
 */

import {
  CONVERSATION_NAMED_EVENT_TYPE,
  type InferenceTransport,
  type JsonValue,
} from "../../core/contracts";
import { sha256, stableStringify } from "../../core/hash";
import type { EventDraft } from "../../core/journal";
import { finalizeProviderReceipt } from "../../receipts/types";
import type { ConversationReceipt } from "../../receipts/types";

/**
 * The title `PrimeRuntime.createSession` writes when the host supplies none.
 * The auto-naming gate is "still carrying this minted default", mirroring the
 * UI's `isAppMintedConversationTitle` — a host-supplied title or an explicit
 * rename both read as "no title override given" being false.
 *
 * Defined here rather than in `runtime.ts` so the session authority and the
 * runtime facade share one constant without an import cycle.
 */
export const PRIME_DEFAULT_SESSION_TITLE = "Prime conversation";

/**
 * Verbatim copy of app.tsx's `CONVERSATION_NAMING_PROMPT`. The request digest
 * the receipt chains commitments to is computed over this exact string, so
 * drifting from the UI's wording silently changes what a naming receipt proves.
 */
export const PRIME_CONVERSATION_NAMING_PROMPT =
  "You name conversations. Reply with a title of at most six words for the message that follows. "
  + "Describe what it is about. No quotation marks, no trailing punctuation, no preamble.";

/**
 * How much of a naming answer is kept — verbatim app.tsx
 * `MAX_CONVERSATION_NAMING_ANSWER`, well under the session audit's 4 KiB
 * answer bound. A title is at most 64 characters; anything past this cap is
 * already an essay the record exists only to account for, and keeping the
 * whole of an unbounded stream would let one bad answer make the naming
 * record permanently unauditable.
 */
export const PRIME_MAX_NAMING_ANSWER_CHARS = 1_024;

/**
 * When the answer crosses this many characters the stream is abandoned: a
 * naming call that starts producing an essay is not naming anything. Verbatim
 * app.tsx break condition.
 */
const PRIME_NAMING_STREAM_ABANDON_CHARS = 240;

/** Payload marker naming why the usage exists; verbatim app.tsx. */
export const PRIME_NAMING_USAGE_SOURCE = "conversation-naming";

/** What the naming inference produced, including what it cost and what proves it. */
export type PrimeConversationNaming = Readonly<{
  /**
   * Absent when the request completed but its answer is not a usable name.
   *
   * That outcome is a *result*, not a failure: the request was made, billed
   * and attested, and only the rename is skipped. Collapsing it into
   * `undefined` alongside a network failure is what left a completed paid
   * call recorded nowhere.
   */
  title?: string;
  /** The provider's exact answer, so the receipt's response digest is checkable. */
  answer: string;
  usage?: Readonly<{ inputTokens?: number; outputTokens?: number }>;
  receipt?: ConversationReceipt;
}>;

/** The fresh identity one naming request is issued and journaled under. */
export type PrimeConversationNamingIdentity = Readonly<{
  sessionId: string;
  turnId: string;
  operationId: string;
}>;

/** Mirror of app.tsx `conversationTitleFromPrompt` (64-char ellipsis cap). */
export function primeConversationTitleFromPrompt(prompt: string): string {
  const normalized = prompt.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const maximum = 64;
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * Mirror of app.tsx `usableConversationTitle`: NFKC, control characters to
 * spaces, packaging quotes and trailing punctuation stripped, whitespace
 * collapsed — then refused when empty, over 64 characters, or over eight
 * words (a refusal or a preamble is longer than any title worth keeping).
 * Every accepted title is inside `EventJournal.renameSession`'s 1–240
 * printable-character bound by construction.
 */
export function primeUsableConversationTitle(answer: string): string | undefined {
  const normalized = answer
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    // Models like to wrap a title in quotes and end it with a full stop.
    .replace(/^\s*["\u2018\u2019\u201c\u201d'`]+|["\u2018\u2019\u201c\u201d'`]+\s*$/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.,;:]+$/u, "")
    .trim();
  if (!normalized || normalized.length > 64) return undefined;
  if (normalized.split(" ").length > 8) return undefined;
  return normalized;
}

/**
 * Mirror of app.tsx `conversationTitleFromModel`: run the naming request on
 * the given transport and return the outcome with its cost and proof, or
 * `undefined` when nothing attestable happened (failure, abort, or an empty
 * stream — a request nobody can account for is recorded nowhere).
 */
export async function primeConversationTitleFromModel(options: Readonly<{
  transport: InferenceTransport;
  model: string;
  content: string;
  identity: PrimeConversationNamingIdentity;
  signal?: AbortSignal;
}>): Promise<PrimeConversationNaming | undefined> {
  const { transport, model, identity } = options;
  try {
    const messages = [{ role: "user" as const, content: primeConversationTitleFromPrompt(options.content) }];
    const events = transport.stream({
      requestId: identity.operationId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      model,
      systemPrompt: PRIME_CONVERSATION_NAMING_PROMPT,
      messages,
      tools: [],
      idempotencyKey: identity.operationId,
    }, options.signal ?? new AbortController().signal);
    let text = "";
    let usage: PrimeConversationNaming["usage"];
    let receipt: ConversationReceipt | undefined;
    for await (const event of events) {
      // Clamped as it accumulates, not after: a single delta can be
      // arbitrarily large, the audit bounds a naming record's answer at
      // 4 KiB, and the response digest below is taken over exactly this
      // string — so what the journal stores stays recomputable from the
      // journal rather than from a longer answer nobody kept.
      if (event.type === "text-delta") text = `${text}${event.text}`.slice(0, PRIME_MAX_NAMING_ANSWER_CHARS);
      if (event.type === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      if (event.type === "completed") receipt = event.receipt;
      // A naming call that starts producing an essay is not naming anything.
      if (text.length > PRIME_NAMING_STREAM_ABANDON_CHARS || event.type === "completed") break;
    }
    // Nothing observable came back, so there is no request to attest to. Any
    // one of these three is evidence the provider was reached and charged.
    if (!text && !usage && !receipt) return undefined;
    const title = primeUsableConversationTitle(text);
    return Object.freeze({
      ...(title ? { title } : {}),
      answer: text,
      ...(usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? { usage } : {}),
      // Normalized exactly as a turn receipt is, and bound to the request
      // that was actually made: the prompt is the constant above plus the
      // journaled first message, and the answer is stored beside it, so the
      // two digests can be recomputed from the record rather than taken on
      // trust.
      ...(receipt
        ? {
            receipt: finalizeProviderReceipt(
              receipt,
              transport.id,
              await sha256(stableStringify({
                model,
                systemPrompt: PRIME_CONVERSATION_NAMING_PROMPT,
                messages,
                tools: [],
                idempotencyKey: identity.operationId,
              } as unknown as JsonValue)),
              await sha256(text),
            ),
          }
        : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * The exact drafts the airship writer appends for one naming outcome
 * (`src/ui/app.tsx`'s `CONVERSATION_NAMED_EVENT_TYPE` append): the named
 * record first, then the usage in its own event under the same fresh
 * identity. Cost belonging is the whole shape — the usage rides the naming
 * request's identity, so it joins this session's account without ever
 * entering a turn's per-request log namespace, and the `source` field keeps
 * the usage/Infer-provider-receipt separation the audit and the transcript
 * presentation both key on.
 */
export function primeConversationNamingDrafts(
  named: PrimeConversationNaming,
  options: Readonly<{ model: string; turnId: string; operationId: string }>,
): EventDraft[] {
  return [
    {
      type: CONVERSATION_NAMED_EVENT_TYPE,
      turnId: options.turnId,
      operationId: options.operationId,
      payload: {
        // Absent when the answer was a refusal or an essay: the record then
        // states what came back and that no name was adopted, rather than
        // inventing one or vanishing.
        ...(named.title ? { title: named.title } : {}),
        answer: named.answer,
        model: options.model,
        ...(named.receipt ? { receipt: named.receipt as unknown as JsonValue } : {}),
      },
    },
    ...(named.usage
      ? [{
          type: "inference.usage",
          turnId: options.turnId,
          operationId: options.operationId,
          payload: {
            ...(named.usage.inputTokens !== undefined ? { inputTokens: named.usage.inputTokens } : {}),
            ...(named.usage.outputTokens !== undefined ? { outputTokens: named.usage.outputTokens } : {}),
            source: PRIME_NAMING_USAGE_SOURCE,
          },
        }]
      : []),
  ];
}
