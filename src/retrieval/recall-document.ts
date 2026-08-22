/**
 * The ambient-recall index document, separated from the lane that fills it.
 *
 * Two surfaces need this schema and only this schema: the turn lane that reads
 * and refreshes it (`ambient-recall.ts`, inside the agent tool bundle) and the
 * Memory route's panel, which shows a person what is indexed and carries the
 * switch that turns it off. Keeping the schema here means the panel does not
 * pull the indexer — the same split `memory-document.ts` already makes for
 * `memory.json`, and for the same measured reason.
 *
 * The document lives at a `/workspace/.airship/` path, so it is written through
 * whatever `WorkspacePort` the active Profile is bound to. That is the whole
 * storage answer: an Ephemeral Profile's port is page memory and persists
 * nothing, a Vault Profile's port encrypts on this device before the bytes
 * leave it, and `ProfileWorkspacePort` roots every path under one Profile, so
 * the index cannot be read or written across a Profile boundary. Which
 * conversations may enter it is a separate fence, enforced in `ambient-recall.ts`,
 * because the journal is shared by every Profile in this browser.
 *
 * `.airship` is also `isWorkspaceControlPlanePath`, so the workspace indexer
 * and the file tools never read this file back as workspace material.
 */
import { isRecord } from "../core/records";

export const RECALL_PATH = "/workspace/.airship/recall.json";

/** Excerpts kept, newest last. Matches `rankProfileMemories`' own corpus cap. */
export const RECALL_MAX_EXCERPTS = 512;
/** Characters of one message kept per excerpt window. */
export const RECALL_EXCERPT_CHARACTERS = 400;
/** Windows per message, so one long message cannot own the corpus. */
export const RECALL_WINDOWS_PER_MESSAGE = 3;
/**
 * Bytes the whole document may occupy. A Vault rewrites this object whenever a
 * turn adds to it, so the corpus cap alone — 512 windows of 400 characters — is
 * a quarter of a megabyte of encrypted write per turn. The oldest excerpts are
 * dropped first, which is also the order `rankProfileMemories` treats as least
 * recent.
 */
export const RECALL_DOCUMENT_BYTES = 64 * 1024;
/** Conversations scanned per refresh, most recently updated first. */
export const RECALL_SCANNED_CONVERSATIONS = 64;
/** Excerpts admitted into one turn. */
export const RECALL_TURN_HITS = 2;
/** Bytes of recalled text admitted into one turn, provenance included. */
export const RECALL_TURN_BYTES = 1_024;

export type RecallExcerpt = Readonly<{
  /** The conversation this line was said in. */
  sessionId: string;
  /** That conversation's title when the line was indexed. */
  title: string;
  /** Journal sequence of the event, which is the turn's position in it. */
  sequence: number;
  who: "you" | "the agent";
  at: string;
  text: string;
}>;

export type RecallDocument = Readonly<{
  version: 1;
  /** The person's switch. Off means nothing is indexed and nothing is recalled. */
  enabled: boolean;
  /** Journal sequence already distilled, per conversation. */
  cursors: Readonly<Record<string, number>>;
  /** Oldest first: `rankProfileMemories` reads corpus position as recency. */
  excerpts: readonly RecallExcerpt[];
}>;

export function emptyRecallDocument(enabled = true): RecallDocument {
  return Object.freeze({ version: 1, enabled, cursors: Object.freeze({}), excerpts: Object.freeze([]) });
}

/**
 * One line of provenance, welded to the front of the excerpt.
 *
 * Written here rather than at either call site so the sentence the agent is
 * handed and the sentence the Memory panel shows cannot drift apart. The agent
 * never receives a recalled line without it, which is what makes "you said
 * this, there" the only claim it can make from this corpus.
 */
export function recallProvenance(excerpt: RecallExcerpt): string {
  const who = excerpt.who === "you" ? "You said" : "The agent said";
  return `${who}, in "${excerpt.title}" (turn ${excerpt.sequence}, ${excerpt.at.slice(0, 10)})`;
}

export function recallLine(excerpt: RecallExcerpt): string {
  return `${recallProvenance(excerpt)}: ${excerpt.text}`;
}

/** A missing, unreadable or foreign document reads as an empty one, never as an error. */
export function parseRecallDocument(content: string | undefined): RecallDocument {
  if (!content) return emptyRecallDocument();
  let value: unknown;
  try { value = JSON.parse(content); } catch { return emptyRecallDocument(); }
  if (!isRecord(value) || value.version !== 1) return emptyRecallDocument();
  const cursors: Record<string, number> = {};
  if (isRecord(value.cursors)) {
    for (const [id, sequence] of Object.entries(value.cursors)) {
      if (id.length <= 512 && Number.isSafeInteger(sequence) && (sequence as number) >= 0) {
        cursors[id] = sequence as number;
      }
    }
  }
  const excerpts: RecallExcerpt[] = [];
  if (Array.isArray(value.excerpts)) {
    for (const candidate of value.excerpts.slice(0, RECALL_MAX_EXCERPTS)) {
      const excerpt = canonicalRecallExcerpt(candidate);
      if (excerpt) excerpts.push(excerpt);
    }
  }
  return Object.freeze({
    version: 1,
    enabled: value.enabled !== false,
    cursors: Object.freeze(cursors),
    excerpts: Object.freeze(excerpts),
  });
}

export function canonicalRecallExcerpt(value: unknown): RecallExcerpt | undefined {
  if (!isRecord(value)) return undefined;
  const { sessionId, title, sequence, who, at, text } = value;
  if (
    typeof sessionId !== "string" || !sessionId || sessionId.length > 512 ||
    typeof title !== "string" || title.length > 512 ||
    !Number.isSafeInteger(sequence) || (sequence as number) < 0 ||
    (who !== "you" && who !== "the agent") ||
    typeof at !== "string" || !Number.isFinite(Date.parse(at)) ||
    typeof text !== "string" || !text || text.length > RECALL_EXCERPT_CHARACTERS
  ) return undefined;
  return Object.freeze({ sessionId, title, sequence: sequence as number, who, at, text });
}

export function serializeRecallDocument(document: RecallDocument): string {
  return `${JSON.stringify({
    version: 1,
    enabled: document.enabled,
    cursors: document.cursors,
    excerpts: document.excerpts,
  })}\n`;
}

/**
 * Drop the oldest excerpts until the serialized document fits its byte cap.
 *
 * Measured on the document rather than guessed from the corpus cap: an excerpt
 * carries a title and a timestamp as well as its 400 characters, and a Vault
 * pays for every one of those bytes on every turn that adds a line.
 */
export function boundRecallDocument(document: RecallDocument): RecallDocument {
  let excerpts = document.excerpts.slice(-RECALL_MAX_EXCERPTS);
  const encoder = new TextEncoder();
  while (
    excerpts.length > 1 &&
    encoder.encode(serializeRecallDocument({ ...document, excerpts })).byteLength > RECALL_DOCUMENT_BYTES
  ) {
    excerpts = excerpts.slice(Math.max(1, Math.ceil(excerpts.length / 16)));
  }
  return Object.freeze({ ...document, excerpts: Object.freeze(excerpts) });
}
