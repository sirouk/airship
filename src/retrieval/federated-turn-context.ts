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
import { MEMORY_PATH, parseMemoryDocument, type MemoryRecord } from "../tools/memory-tools";

const DEFAULT_MAX_HITS = 6;
const DEFAULT_MAX_BYTES = 24 * 1024;
const MAX_PROFILE_MEMORY_HITS = 3;

/**
 * Turn retrieval over separately governed corpora. Profile memory is selected
 * lexically and workspace/source material uses the active on-device embedding
 * generation. Scores never cross corpus boundaries; the bounded memory lane is
 * placed first, followed by workspace results in their native rank order.
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
      ? scopedMemories(memoryDocument?.records ?? [], profile.profileId, profile.version === 2 ? profile.memoryScope : "profile", session.id)
      : [];
    const memoryCandidates = await rankMemories(memoryRecords, query);
    const memoryGeneration = memoryFile && memoryCandidates.length
      ? await memoryLineage(memoryFile.revision, memoryFile.content)
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
    candidates.push(...workspaceSelection.hits);

    const hits: CanonicalContextHit[] = [];
    let selectedBytes = 0;
    let truncated = workspaceSelection.truncated || candidates.length > maxHits;
    for (const candidate of candidates) {
      if (hits.length >= maxHits) { truncated = true; break; }
      const remaining = maxBytes - selectedBytes;
      if (remaining <= 0) { truncated = true; break; }
      const text = truncateUtf8(candidate.text, remaining);
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
      ...workspaceGenerations,
    ]);
    const scope = Object.freeze({
      sessionId: session.id,
      ...(profile ? {
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        memoryScope: profile.version === 2 ? profile.memoryScope : "profile" as const,
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

function scopedMemories(
  records: readonly MemoryRecord[],
  profileId: string,
  scope: "session" | "profile" | "workspace",
  sessionId: string,
): MemoryRecord[] {
  return records.filter((record) =>
    record.scope.kind === "profile" &&
    record.scope.profileId === profileId &&
    (scope !== "session" || record.scope.createdInSessionId === sessionId),
  );
}

async function rankMemories(records: readonly MemoryRecord[], query: string) {
  const queryTokens = new Set(tokenize(query));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ranked = await Promise.all(records.map(async (record, index) => {
    const haystack = `${record.content}\n${record.source}`.toLocaleLowerCase();
    const available = new Set(tokenize(haystack));
    let overlap = 0;
    for (const token of queryTokens) if (available.has(token)) overlap += 1;
    const lexical = queryTokens.size ? overlap / queryTokens.size : 0;
    const phrase = normalizedQuery && haystack.includes(normalizedQuery) ? 1 : 0;
    const score = Math.min(1, 0.75 * Math.max(lexical, phrase) + 0.25 * ((index + 1) / Math.max(records.length, 1)));
    return { record, score, contentDigest: await sha256(record.content) };
  }));
  return ranked
    .filter((candidate) => candidate.score > 0.25)
    .sort((left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt));
}

async function memoryLineage(revision: string, content: string): Promise<CanonicalContextGeneration> {
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
    indexFormat: "bounded-lexical-recent-v1",
    persistence: "memory-only",
  });
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character).byteLength > maxBytes) break;
    output += character;
  }
  return output;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is invalid.`);
  return value;
}
