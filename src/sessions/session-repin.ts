import { SESSION_RE_PINNED_EVENT_TYPE } from "../core/session-repin-record";
import { effectiveSessionModel, type EventJournal } from "../core/journal";
import type { SessionLibraryDetail } from "./library";

export { SESSION_RE_PINNED_EVENT_TYPE };

/**
 * The differences a re-pin cures, by the code `decideSessionResume` files.
 *
 * These are the reasons that stopped requiring a fork, so this list and that
 * function have to agree exactly: a code here that still forces a fork would
 * write a record for something that did not happen, and a code missing here
 * would re-pin a conversation and journal nothing. `session-repin.test.ts`
 * drives `decideSessionResume` over every drift and holds the two in agreement
 * rather than transcribing either.
 */
export const SESSION_RE_PINNED_DIFFERENCES: ReadonlySet<string> = new Set([
  "PROVIDER_MISMATCH",
  "MODEL_MISMATCH",
  "INFERENCE_CONNECTION_MISMATCH",
  "TOOL_MANIFEST_MISMATCH",
  "WORKSPACE_MISMATCH",
  "POSTURE_AMBIGUOUS",
  "POSTURE_MISMATCH",
]);

/**
 * The credential-free half of the shell's live runtime — exactly the fields
 * `sessionManifestRuntime` reads to build the next turn's authority, and
 * nothing else. Structural, so the shell hands over what it already holds and
 * the baseline bundle carries no part of this composition.
 */
type RePinAuthority = Readonly<{
  transport: Readonly<{ id: string; posture: string }>;
  workspaceId?: string;
  inferenceBinding?: Readonly<{ providerId: string }>;
}>;

/*
 * The event type and the difference vocabulary are defined in
 * `core/session-repin-record.ts`, beside the turn admission that reads them,
 * so the writer here and the reader there cannot drift apart and `core` never
 * has to import `sessions` back. The record is bookkeeping in the same sense
 * as `profile.active-conversation.selected`: a fact about where the thread now
 * runs, not something the thread said, digest-chained like everything else,
 * named and validated by the audit, and listed by local inspection.
 */

/**
 * Write the durable half of "continuing re-pins to what is active".
 *
 * The rule this belongs to lives in `decideSessionResume`: a provider, model,
 * tool set, workspace, posture or inference binding that has moved is a fact
 * about this tab, and it neither blocks a conversation nor requires a fork.
 * The runtime half of the re-pin is silent — `sessionManifestRuntime` builds
 * the next turn's authority out of whatever is active — and a silent re-pin is
 * a change nobody can audit afterwards. So the moment a person continues, the
 * journal says so, in the journal's own chain, before the transcript is read.
 *
 * Credential-free by construction: a provider id, a model id, the transport
 * posture, the workspace and the tool digest are the same fields the manifest
 * already publishes. No token, no account, no endpoint.
 *
 * Returns the codes it recorded, or an empty array when nothing had moved and
 * nothing was written — an empty re-pin record would be a claim about a change
 * that did not happen.
 *
 * Lives in the deferred capability pack rather than in the shell: it runs once,
 * when somebody opens a conversation whose pins moved, and the baseline
 * JavaScript a first paint waits on has no business carrying it.
 */
export async function journalSessionRePin(
  journal: EventJournal,
  detail: SessionLibraryDetail,
  runtime: RePinAuthority,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const { session } = detail;
  const differences = [...new Set(
    (detail.compatibility?.reasons ?? [])
      .filter((reason) => SESSION_RE_PINNED_DIFFERENCES.has(reason.code))
      .map((reason) => reason.code),
  )].sort();
  if (!differences.length) return differences;
  const payload = {
    version: 1,
    providerId: runtime.inferenceBinding?.providerId ?? runtime.transport.id,
    model: effectiveSessionModel(session),
    posture: runtime.transport.posture,
    toolManifestDigest: session.manifest.toolManifestDigest,
    ...(runtime.workspaceId === undefined ? {} : { workspaceId: runtime.workspaceId }),
    differences,
  };
  /*
   * An exact re-pin is idempotent.
   *
   * The manifest is immutable, so a conversation that was continued on this
   * route still reports the same drift the next time it is opened. Appending a
   * second identical record for the same route would turn ordinary navigation
   * into journal noise and make "where was this continued" a list to scan
   * rather than an answer to read.
   */
  const events = await journal.readEvents(session.id, 0, signal);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== SESSION_RE_PINNED_EVENT_TYPE) continue;
    return JSON.stringify(event.payload) === JSON.stringify(payload) ? [] : append();
  }
  return append();

  async function append(): Promise<readonly string[]> {
    await journal.append(session.id, [{ type: SESSION_RE_PINNED_EVENT_TYPE, payload }], signal);
    return differences;
  }
}
