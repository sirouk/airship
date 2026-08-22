import { boundChunkTextToBytes } from "./codec";
import { refreshRecallIndex, selectRecalledLines } from "./ambient-recall";
import { RECALL_TURN_HITS, serializeRecallDocument } from "./recall-document";
import {
  sealContextSelection,
  type CanonicalContextGeneration,
  type CanonicalContextHit,
  type CanonicalContextSelection,
  type TurnContextProvider,
  type TurnContextRequest,
} from "../core/context-selection";
import { sha256, stableStringify } from "../core/hash";
import type { JsonValue } from "../core/contracts";
import type { EventJournal } from "../core/journal";
import type { WorkspacePort } from "../workspace/contracts";
import { MEMORY_PATH, effectiveMemoryScope, parseMemoryDocument, scopedMemories, type MemoryRecord } from "../tools/memory-tools";
import { rankProfileMemories } from "./memory-ranking";

const DEFAULT_MAX_HITS = 6;
const DEFAULT_MAX_BYTES = 24 * 1024;
const MAX_PROFILE_MEMORY_HITS = 3;

/**
 * Turn retrieval over separately governed corpora. Profile memory is ranked by
 * the shared bounded BM25 lane and workspace/source material uses the active on-device embedding
 * generation. Scores never cross corpus boundaries; the bounded memory lane is
 * placed first, followed by workspace results in their native rank order.
 *
 * Ambient recall sits between them, and its position is the token argument: it
 * is bounded to two lines and 1,024 bytes, while workspace hits are neither, so
 * putting recall after them would mean a large file silently spends the budget
 * a person's own sentence needed. All three lanes share the one `maxHits` /
 * `maxBytes` the turn already had, so no corpus can grow a turn past what it
 * cost before this existed — and a turn with nothing relevant to recall pays
 * nothing at all, because an empty lane contributes neither a hit nor a
 * lineage generation.
 */
export class FederatedTurnContextProvider implements TurnContextProvider {
  constructor(
    private readonly workspaceContext: TurnContextProvider,
    private readonly workspace: WorkspacePort,
    private readonly journal: EventJournal,
  ) {}

  async selectForTurn(query: string, request: TurnContextRequest): Promise<CanonicalContextSelection> {
    const maxHits = boundedInteger(request.maxHits ?? DEFAULT_MAX_HITS, 1, 8, "turn context hit limit");
    const maxBytes = boundedInteger(request.maxBytes ?? DEFAULT_MAX_BYTES, 1, 32 * 1024, "turn context byte limit");
    const session = await this.journal.getSession(request.sessionId, request.signal);
    if (!session) throw new Error(`Context authority session was not found: ${request.sessionId}.`);

    const workspaceSelection = await this.workspaceContext.selectForTurn(query, {
      ...request,
      maxHits,
      maxBytes,
    });
    const profile = session.manifest.profile;
    const memoryFile = profile ? await this.workspace.read(MEMORY_PATH) : undefined;
    const memoryDocument = memoryFile ? parseMemoryDocument(memoryFile.content) : undefined;
    const memoryRecords = profile
      ? scopedMemories(memoryDocument?.records ?? [], {
        profileId: profile.profileId,
        memoryScope: effectiveMemoryScope(profile),
        sessionId: session.id,
      })
      : [];
    const memoryCandidates = await rankMemories(memoryRecords, query);
    const memoryGeneration = memoryFile && memoryCandidates.length
      ? await memoryLineage(memoryFile.revision, memoryFile.content)
      : undefined;

    const recallState = profile
      ? await refreshRecallIndex(this.workspace, this.journal, profile.profileId, request.signal)
      : undefined;
    const recalled = recallState?.file
      ? selectRecalledLines(recallState.document, query, session.id)
      : [];
    const recallGeneration = recalled.length && recallState?.file
      ? await conversationLineage(recallState.file.revision, serializeRecallDocument(recallState.document))
      : undefined;

    const candidates: CanonicalContextHit[] = [];
    if (memoryGeneration) {
      for (const candidate of memoryCandidates.slice(0, Math.min(MAX_PROFILE_MEMORY_HITS, maxHits))) {
        candidates.push(Object.freeze({
          path: `memory://profile/${encodeURIComponent(profile!.profileId)}/${encodeURIComponent(candidate.record.id)}`,
          revision: memoryFile!.revision,
          contentDigest: candidate.contentDigest,
          chunkId: await sha256(`${candidate.record.id}\0${candidate.record.createdAt}\0${candidate.contentDigest}`),
          chunkIndex: 0,
          score: candidate.score,
          text: candidate.record.content,
          textDigest: candidate.contentDigest,
          corpus: "profile-memory",
          sourceId: candidate.record.id,
          lineageRef: memoryGeneration.id,
        }));
      }
    }
    if (recallGeneration && recallState?.file) {
      for (const line of recalled.slice(0, Math.min(RECALL_TURN_HITS, maxHits))) {
        const textDigest = await sha256(line.text);
        candidates.push(Object.freeze({
          path: `conversation://${encodeURIComponent(line.excerpt.sessionId)}/${line.excerpt.sequence}`,
          revision: recallState.file.revision,
          contentDigest: await sha256(line.excerpt.text),
          chunkId: await sha256(`${line.excerpt.sessionId}\0${line.excerpt.sequence}\0${textDigest}`),
          chunkIndex: 0,
          score: line.score,
          text: line.text,
          textDigest,
          corpus: "conversation",
          sourceId: line.excerpt.sessionId,
          lineageRef: recallGeneration.id,
        }));
      }
    }
    candidates.push(...workspaceSelection.hits);

    const hits: CanonicalContextHit[] = [];
    let selectedBytes = 0;
    let truncated = workspaceSelection.truncated || candidates.length > maxHits;
    for (const candidate of candidates) {
      if (hits.length >= maxHits) { truncated = true; break; }
      const remaining = maxBytes - selectedBytes;
      if (remaining <= 0) { truncated = true; break; }
      const text = boundChunkTextToBytes(candidate.text, remaining);
      if (!text) { truncated = true; break; }
      const bytes = new TextEncoder().encode(text).byteLength;
      selectedBytes += bytes;
      if (text !== candidate.text) truncated = true;
      hits.push(Object.freeze({
        ...candidate,
        text,
        textDigest: text === candidate.text ? candidate.textDigest : await sha256(text),
      }));
      if (text !== candidate.text) break;
    }

    const workspaceGenerations = workspaceSelection.lineage?.generations ?? [];
    const generations = Object.freeze([
      ...(memoryGeneration ? [memoryGeneration] : []),
      ...(recallGeneration ? [recallGeneration] : []),
      ...workspaceGenerations,
    ]);
    const scope = Object.freeze({
      sessionId: session.id,
      ...(profile ? {
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        memoryScope: effectiveMemoryScope(profile),
      } : {}),
      workspaceId: session.manifest.workspaceId,
    });
    const generationDigest = await sha256(stableStringify({
      retriever: "airship-federated-turn-context-v1",
      scope,
      generations: generations.map((generation) => generation.id),
    } as unknown as JsonValue));

    return sealContextSelection({
      version: 2,
      queryDigest: workspaceSelection.queryDigest,
      generationDigest,
      workspaceSnapshotDigest: workspaceSelection.workspaceSnapshotDigest,
      selectedAt: workspaceSelection.selectedAt,
      maxHits,
      maxBytes,
      selectedBytes,
      truncated,
      hits: Object.freeze(hits),
      lineage: Object.freeze({
        retriever: "airship-federated-turn-context-v1",
        scope,
        generations,
      }),
      ...(workspaceSelection.retrieval ? { retrieval: workspaceSelection.retrieval } : {}),
    });
  }
}

async function rankMemories(records: readonly MemoryRecord[], query: string) {
  return Promise.all(rankProfileMemories(records, query).map(async (candidate) => ({
    record: candidate.record,
    score: candidate.score,
    contentDigest: await sha256(candidate.record.content),
  })));
}

/**
 * The conversation corpus's lineage.
 *
 * `persistence` makes the same claim `memoryLineage` makes about a `memory.json`
 * that may well be sitting in a Vault: it describes the ranking structure this
 * turn scored against, which is built in this page and published nowhere. Where
 * the excerpt document itself lives is the Profile's storage choice — page
 * memory for Ephemeral, the same encrypted objects as the conversations for a
 * Vault — and the Memory panel is where a person is told which.
 */
async function conversationLineage(revision: string, content: string): Promise<CanonicalContextGeneration> {
  const sourceDigest = await sha256(content);
  const id = await sha256(stableStringify({
    corpus: "conversation",
    revision,
    sourceDigest,
    extractor: "airship-conversation-excerpt-v1",
  }));
  return Object.freeze({
    id,
    corpus: "conversation",
    sourceRevision: revision,
    sourceDigest,
    extractor: "airship-conversation-excerpt-v1",
    chunker: "message-window-v1",
    indexFormat: "bounded-bm25-recent-v1",
    persistence: "memory-only",
  });
}

/** Shared with the agent-facing memory tools so tool lineage matches turn lineage. */
export async function memoryLineage(revision: string, content: string): Promise<CanonicalContextGeneration> {
  const sourceDigest = await sha256(content);
  const id = await sha256(stableStringify({
    corpus: "profile-memory",
    revision,
    sourceDigest,
    extractor: "airship-explicit-memory-v2",
  }));
  return Object.freeze({
    id,
    corpus: "profile-memory",
    sourceRevision: revision,
    sourceDigest,
    extractor: "airship-explicit-memory-v2",
    chunker: "record-boundary-v1",
    indexFormat: "bounded-bm25-recent-v1",
    persistence: "memory-only",
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is invalid.`);
  return value;
}
