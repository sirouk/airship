/**
 * Ambient recall: the conversations this Profile already has, made findable.
 *
 * The measured failure this exists for: a person wrote "I like unicorn milk and
 * I want it to be blue" in one conversation and asked "what kind of milk do I
 * like most?" in another. `recall_memory` searched `memory.json`, found nothing
 * — correctly, because nobody had pinned anything — and the agent said it did
 * not know. Nothing in the product had ever read a conversation.
 *
 * What this does NOT do, on purpose:
 *
 * - It never asks a model what is worth remembering about a person. There is no
 *   summarizer here, no extracted "fact", no profile inference. It keeps the
 *   characters the person typed and the characters the agent replied with, and
 *   nothing else is ever presented as something they said.
 * - It never crosses a Profile or outlives the storage a person chose. The
 *   document is an ordinary workspace object at `RECALL_PATH`, so it inherits
 *   the active `WorkspacePort` exactly as `memory.json` does — and because one
 *   journal holds every Profile's conversations, `refreshRecallIndex` also
 *   refuses to read a conversation whose manifest names a different Profile.
 * - It never speaks without a source. Every admitted line is welded to its
 *   provenance by `recallLine` before it can reach a prompt.
 */
import { boundChunkTextToBytes } from "./codec";
import { rankProfileMemories } from "./memory-ranking";
import {
  RECALL_EXCERPT_CHARACTERS,
  RECALL_PATH,
  RECALL_SCANNED_CONVERSATIONS,
  RECALL_TURN_BYTES,
  RECALL_TURN_HITS,
  RECALL_WINDOWS_PER_MESSAGE,
  boundRecallDocument,
  emptyRecallDocument,
  parseRecallDocument,
  recallLine,
  serializeRecallDocument,
  type RecallDocument,
  type RecallExcerpt,
} from "./recall-document";
import { isRecord } from "../core/records";
import type { DurableEvent, EventJournal } from "../core/journal";
import type { WorkspaceFile, WorkspacePort } from "../workspace/contracts";

export type RecallIndexState = Readonly<{ document: RecallDocument; file?: WorkspaceFile }>;

/**
 * Bring the index up to date with this Profile's conversations, then return it.
 *
 * Incremental by conversation head: a conversation whose `headSequence` has not
 * moved past its recorded cursor is not read at all, so after the first pass a
 * turn reads the events of the conversation it is in and nothing else. A
 * conversation that no longer exists — or that belongs to another Profile —
 * loses its cursor and its excerpts in the same pass, so deleting a
 * conversation deletes what it could recall.
 *
 * Failure is silent by design: recall is an addition to a turn, and a storage
 * hiccup in it must never fail the turn. The turn then runs with whatever the
 * index already held, which is the same answer as "nothing relevant".
 */
export async function refreshRecallIndex(
  workspace: WorkspacePort,
  journal: EventJournal,
  profileId: string,
  signal?: AbortSignal,
): Promise<RecallIndexState> {
  let file: WorkspaceFile | undefined;
  let document: RecallDocument;
  try {
    file = await workspace.read(RECALL_PATH);
    document = parseRecallDocument(file?.content);
  } catch { return Object.freeze({ document: emptyRecallDocument() }); }
  const held = Object.freeze({ document, ...(file ? { file } : {}) });
  if (!document.enabled) return held;

  let sessions;
  try { sessions = await journal.listSessions(signal); } catch { return held; }
  const live = sessions
    .filter((session) => session.manifest.profile?.profileId === profileId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECALL_SCANNED_CONVERSATIONS);
  const liveIds = new Set(live.map((session) => session.id));

  const cursors: Record<string, number> = {};
  for (const [id, sequence] of Object.entries(document.cursors)) if (liveIds.has(id)) cursors[id] = sequence;
  let excerpts = document.excerpts.filter((excerpt) => liveIds.has(excerpt.sessionId));
  let changed = excerpts.length !== document.excerpts.length
    || Object.keys(cursors).length !== Object.keys(document.cursors).length;

  for (const session of live) {
    const cursor = cursors[session.id] ?? 0;
    if (session.headSequence <= cursor) continue;
    let events: readonly DurableEvent[];
    try { events = await journal.readEvents(session.id, cursor, signal); } catch { continue; }
    const fresh = events.flatMap((event) => excerptsFromEvent(event, session.title));
    if (fresh.length) excerpts = [...excerpts, ...fresh];
    cursors[session.id] = session.headSequence;
    changed = true;
  }
  if (!changed) return held;

  const next = boundRecallDocument(Object.freeze({
    version: 1,
    enabled: document.enabled,
    cursors: Object.freeze(cursors),
    excerpts: Object.freeze([...excerpts].sort((left, right) =>
      left.at.localeCompare(right.at) || left.sequence - right.sequence)),
  }));
  try {
    const written = await workspace.write(RECALL_PATH, serializeRecallDocument(next), {
      expectedRevision: file?.revision ?? null,
    });
    return Object.freeze({ document: next, file: written });
  } catch {
    // Another tab won the write. This turn still uses what this pass computed;
    // the next turn re-reads and converges.
    return Object.freeze({ document: next, ...(file ? { file } : {}) });
  }
}

/** The verbatim windows one journal event contributes, or none. */
export function excerptsFromEvent(event: DurableEvent, title: string): RecallExcerpt[] {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  let text: string | undefined;
  let who: RecallExcerpt["who"] | undefined;
  if (event.type === "turn.requested" && typeof payload?.content === "string") {
    text = payload.content;
    who = "you";
  } else if (event.type === "assistant.completed") {
    const message = isRecord(payload?.message) ? payload.message : undefined;
    if (typeof message?.content === "string") {
      text = message.content;
      who = "the agent";
    }
  }
  if (!text || !who) return [];
  const normalized = text.replace(/\s+/gu, " ").trim();
  const windows: RecallExcerpt[] = [];
  for (let index = 0; index < RECALL_WINDOWS_PER_MESSAGE; index += 1) {
    const window = normalized.slice(index * RECALL_EXCERPT_CHARACTERS, (index + 1) * RECALL_EXCERPT_CHARACTERS);
    if (!window) break;
    windows.push(Object.freeze({
      sessionId: event.sessionId,
      title: title.slice(0, 512),
      sequence: event.sequence,
      who,
      at: event.recordedAt,
      text: window,
    }));
  }
  return windows;
}

export type RecalledLine = Readonly<{ excerpt: RecallExcerpt; text: string; score: number }>;

/**
 * Which lines, if any, this turn is entitled to.
 *
 * The ranker is `rankProfileMemories` — the same bounded BM25 with a recency
 * tiebreak that explicit memory and both recall tools already use. That is not
 * reuse for tidiness: its gate is exclusive and exactly equal to its recency
 * weight, so a query with no discriminating lexical overlap tops out at 0.25,
 * fails the gate, and yields nothing. An unrelated turn therefore contributes
 * zero bytes rather than the nearest row in the corpus.
 *
 * The conversation the person is in is excluded. Its transcript is already
 * being sent, so recalling it would spend the turn's budget echoing what the
 * model can already read.
 */
export function selectRecalledLines(
  document: RecallDocument,
  query: string,
  currentSessionId: string,
  budgetBytes = RECALL_TURN_BYTES,
): readonly RecalledLine[] {
  if (!document.enabled) return Object.freeze([]);
  const corpus = document.excerpts.filter((excerpt) => excerpt.sessionId !== currentSessionId);
  if (!corpus.length) return Object.freeze([]);
  const ranked = rankProfileMemories(
    corpus.map((excerpt) => Object.freeze({
      content: excerpt.text,
      source: `${excerpt.title} ${excerpt.who}`,
      createdAt: excerpt.at,
    })),
    query,
    { limit: RECALL_TURN_HITS },
  );
  const lines: RecalledLine[] = [];
  const encoder = new TextEncoder();
  let spent = 0;
  for (const candidate of ranked) {
    const excerpt = corpus[candidate.index];
    if (!excerpt) continue;
    const text = boundChunkTextToBytes(recallLine(excerpt), budgetBytes - spent);
    if (!text) break;
    spent += encoder.encode(text).byteLength;
    lines.push(Object.freeze({ excerpt, text, score: candidate.score }));
  }
  return Object.freeze(lines);
}
