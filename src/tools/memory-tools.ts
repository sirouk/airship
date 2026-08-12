import { objectArguments, requiredString } from "./schema";
import type { JsonValue, SessionProfileBinding, Tool, ToolContext } from "../core/contracts";
import { sha256 } from "../core/hash";
import { randomUuid } from "../core/id";
import { findDedupCandidates, findDuplicateClusters } from "../retrieval/dedup";
import { rankProfileMemories } from "../retrieval/memory-ranking";
import type { EventJournal } from "../core/journal";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "./registry";

export const MEMORY_PATH = "/workspace/.airship/memory.json";
const MAX_MEMORIES = 512;

export type MemoryScope = "session" | "profile" | "workspace";

/**
 * The pinned silo boundary, resolved for pins that predate it. A v1 pin never
 * carried a scope, so it reads as the profile-wide default it was written under
 * — narrowing it retroactively would hide records the session already used.
 */
export function effectiveMemoryScope(profile: SessionProfileBinding): MemoryScope {
  return profile.version === 2 ? profile.memoryScope : "profile";
}

/**
 * The single gate every read of memory.json passes through. Scope is a
 * boundary, not a presentation preference, so the turn seam, `recall_memory`
 * and `search_memory` must all narrow identically or the silo leaks through
 * whichever reader was forgotten.
 */
export function scopedMemories(
  records: readonly MemoryRecord[],
  binding: Readonly<{ profileId: string; memoryScope: MemoryScope; sessionId: string }>,
): MemoryRecord[] {
  return records.filter((item) =>
    item.scope.kind === "profile" &&
    item.scope.profileId === binding.profileId &&
    (binding.memoryScope !== "session" || item.scope.createdInSessionId === binding.sessionId),
  );
}

type ProfileMemoryScope = Readonly<{
  kind: "profile";
  profileId: string;
  profileRevision: string;
  createdInSessionId: string;
}>;

type LegacyMemoryScope = Readonly<{ kind: "legacy-unscoped" }>;

export type MemoryRecord = Readonly<{
  id: string;
  content: string;
  source: string;
  createdAt: string;
  scope: ProfileMemoryScope | LegacyMemoryScope;
}>;

type MemoryDocument = Readonly<{
  records: readonly MemoryRecord[];
  sourceVersion: 1 | 2;
  legacyCount: number;
}>;


type DuplicateSummary = { id: string; excerpt: string; similarity: number; exact: boolean };

/** Compact summary line(s) for tool metadata — ids + excerpts never full prose. */
function duplicateSummaries(
  records: readonly MemoryRecord[],
  candidates: readonly { index: number; similarity: number; exact: boolean }[],
): DuplicateSummary[] {
  return candidates.map((candidate) => {
    const record = records[candidate.index]!;
    return {
      id: record.id,
      excerpt: record.content.length > 96 ? `${record.content.slice(0, 93)}\u2026` : record.content,
      similarity: Math.round(candidate.similarity * 1000) / 1000,
      exact: candidate.exact,
    };
  });
}

const MEMORY_DUPLICATE_EXCERPT_LIMIT = 96;

export function registerMemoryTools(
  registry: ToolRegistry,
  workspace: WorkspacePort,
  journal: EventJournal,
): void {
  const recall: Tool = {
    definition: {
      name: "recall_memory",
      description: "Search explicit memories belonging to this session's pinned profile, ranked by bounded relevance with recency as the tiebreak; an omitted query returns the most recent records, and `duplicates: true` reports duplicate clusters for review. Workspace/source search remains separately shared; legacy unscoped records are quarantined.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 2_048 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          /** When true: rehearse the stored corpus and report duplicate clusters instead of searching. */
          duplicates: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const profile = await pinnedProfile(journal, context);
      const args = objectArguments(argumentsValue);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const limit = typeof args.limit === "number" ? args.limit : 12;
      const file = await workspace.read(MEMORY_PATH);
      const document = file ? parseMemoryDocument(file.content) : emptyDocument();
      const memoryScope = effectiveMemoryScope(profile);
      const records = scopedMemories(document.records, {
        profileId: profile.profileId,
        memoryScope,
        sessionId: context.sessionId,
      });
      if (args.duplicates === true) {
        // The review lane: the same hunter the write path consults, asked
        // over the whole visible corpus, so the agent can say "show me what
        // is pinned twice" without a human opening the Memory tab. Cluster
        // summaries carry ids + excerpts only — full content stays with the
        // records themselves, where digging further already means recall.
        const clusters = findDuplicateClusters(
          records,
          (memory) => memory.content,
          {
            scopeKey: (memory) => memory.scope.kind === "profile" ? memory.scope.profileId : "legacy-unscoped",
            createdAt: (memory) => memory.createdAt,
          },
        );
        const sourceDigest = file ? await sha256(file.content) : null;
        const summaries: { keep: string; members: { id: string; excerpt: string }[]; similarity: number; exact: boolean }[] = await Promise.all(clusters.map(async (cluster) => ({
          keep: records[cluster.representative]!.id,
          members: cluster.members.map((member) => ({ id: records[member]!.id, excerpt: records[member]!.content.slice(0, MEMORY_DUPLICATE_EXCERPT_LIMIT) })),
          similarity: Math.round(cluster.similarity * 1000) / 1000,
          exact: cluster.exact,
        })));
        const reviewMetadata: JsonValue = {
          duplicatesClusterCount: clusters.length,
          count: 0,
          total: records.length,
          ranking: "duplicate-review",
          scope: memoryScope,
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          legacyQuarantined: document.legacyCount,
          revision: file?.revision ?? null,
          sourceDigest,
        };
        return { content: JSON.stringify(summaries, null, 2), metadata: reviewMetadata };
      }
      // An empty query is a browse, not a search: keep the newest records. A real
      // query uses the same ranker as automatic turn injection, so the agent's
      // fallback can never be worse than the lane that already ran.
      const selected = query
        ? rankProfileMemories(records, query, { limit }).map((candidate) => candidate.record)
        : records.slice(-limit).reverse();
      const sourceDigest = file ? await sha256(file.content) : null;
      const searchMetadata: JsonValue = {
        count: selected.length,
        total: records.length,
        ranking: query ? "bounded-bm25-recent-v1" : "reverse-chronological",
        duplicatesClusterCount: 0,
        scope: memoryScope,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        legacyQuarantined: document.legacyCount,
        revision: file?.revision ?? null,
        sourceDigest,
      };
      return {
        content: JSON.stringify(await Promise.all(selected.map(async (record) => ({
          ...record,
          contentDigest: await sha256(record.content),
        }))), null, 2),
        metadata: searchMetadata,
      };
    },
  };

  const update: Tool = {
    definition: {
      name: "update_memory",
      // The printed usage line binds positionals in schema order — `action`,
      // `id`, `content`, `source` — but which of them are required depends on
      // the verb, and `required: ["action"]` cannot say so. Someone following
      // that line with `/update-memory remember "…" "chat"` had the fact bound
      // to `id` and was then told `source must be a non-empty string`, naming
      // as missing the argument they had just typed. The description is printed
      // directly beneath the usage line, so it is where that is said.
      description: "Remember or forget one explicit memory in this session's pinned profile scope. Positionals bind in schema order (action, id, content, source), so use the named form: remember needs --content and --source and ignores --id; forget needs --id. Exact re-pins are idempotent (returned as `already-remembered`); rephrased re-pins report their near-twins in `duplicates`. Profile identity is derived from the accountable session, never tool arguments.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["remember", "forget"] },
          id: { type: "string", maxLength: 128 },
          content: { type: "string", maxLength: 8_192 },
          source: { type: "string", maxLength: 2_048 },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const profile = await pinnedProfile(journal, context);
      const args = objectArguments(argumentsValue);
      const action = requiredString(args.action, "action");
      const current = await workspace.read(MEMORY_PATH);
      const document = current ? parseMemoryDocument(current.content) : emptyDocument();
      const binding = {
        profileId: profile.profileId,
        memoryScope: effectiveMemoryScope(profile),
        sessionId: context.sessionId,
      };
      let next: MemoryRecord[];
      let message: string;
      let pendingDuplicates: readonly import("../retrieval/dedup").DedupCandidate[] | undefined;
      let scopedForDuplicateSummary: readonly MemoryRecord[] | undefined;
      if (action === "remember") {
        if (document.records.length >= MAX_MEMORIES) throw new Error(`Memory is at its ${MAX_MEMORIES}-record limit.`);
        const content = requiredString(args.content, "content");
        const scoped = scopedMemories(document.records, binding);
        // One fact, once. Re-pinning the same wording idempotently returns
        // the standing record instead of growing the corpus with noise, and a
        // rephrased re-pin surfaces its near-twins so the Memory tab's review
        // and the agent lane share one duplicate hunter. `findDedupCandidates`
        // (src/retrieval/dedup.ts) carries the same gates there.
        const duplicates = findDedupCandidates(
          content,
          scoped,
          (memory) => memory.content,
          (memory) => memory.scope.kind === "profile" ? memory.scope.profileId : "legacy-unscoped",
          profile.profileId,
        );
        const exact = duplicates.find((candidate) => candidate.exact);
        if (exact) {
          const standing = scoped[exact.index]!;
          const alreadyMetadata: JsonValue = {
            status: "already-remembered",
            recordId: standing.id,
            count: scoped.length,
            scope: binding.memoryScope,
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            duplicates: duplicateSummaries(scoped, duplicates),
            schemaVersion: 2,
          };
          return { content: `Already remembered as ${standing.id}; the fact is kept once.`, metadata: alreadyMetadata };
        }
        // The write path surfaces near-twins in metadata; the exact lane above
        // already returned. `pendingDuplicates`/`scopedForDuplicateSummary`
        // remember them across the branch so the final metadata can attach.
        if (duplicates.length) {
          pendingDuplicates = duplicates;
          scopedForDuplicateSummary = scoped;
        }
        const record: MemoryRecord = Object.freeze({
          id: randomUuid(),
          content,
          source: requiredString(args.source, "source"),
          createdAt: new Date().toISOString(),
          scope: Object.freeze({
            kind: "profile",
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            createdInSessionId: context.sessionId,
          }),
        });
        next = [...document.records, record];
        message = `Remembered ${record.id} for pinned profile ${profile.profileId}.`;
      } else if (action === "forget") {
        const id = requiredString(args.id, "id");
        // Forget is authorised from the same visible set as recall: a silo the
        // session cannot read must not be one it can destroy by guessing an ID.
        const owned = scopedMemories(document.records, binding).some((record) => record.id === id);
        if (!owned) throw new Error(`Memory not found in pinned profile ${profile.profileId}: ${id}.`);
        next = document.records.filter((record) => record.id !== id);
        message = `Forgot memory ${id} from pinned profile ${profile.profileId}.`;
      } else {
        throw new Error(`Unsupported memory action: ${action}.`);
      }
      const written = await workspace.write(MEMORY_PATH, serializeMemoryDocument(next), {
        expectedRevision: current?.revision ?? null,
      });
      const committedMetadata: JsonValue = {
        count: scopedMemories(next, binding).length,
        scope: binding.memoryScope,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        legacyQuarantined: next.filter((record) => record.scope.kind === "legacy-unscoped").length,
        schemaVersion: 2,
        revision: written.revision,
        path: written.path,
        // Always one shape: a clean `[]` reports that the hunter crossed
        // the corpus and stayed silent. Agent lanes reading this metadata
        // JSON can rely on the key rather than its presence.
        duplicates: pendingDuplicates?.length
          ? duplicateSummaries(scopedForDuplicateSummary ?? [], pendingDuplicates)
          : [],
      };
      return { content: message, metadata: committedMetadata };
    },
  };

  registry.register(recall);
  registry.register(update);
}

export function parseMemoryDocument(content: string): MemoryDocument {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error(`${MEMORY_PATH} is not valid JSON.`); }
  if (!record(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.records) || value.records.length > MAX_MEMORIES) {
    throw new Error(`${MEMORY_PATH} is malformed.`);
  }
  const sourceVersion = value.version;
  const records = value.records.map((item): MemoryRecord => parseRecord(item, sourceVersion));
  const ids = new Set(records.map((item) => item.id));
  if (ids.size !== records.length) throw new Error(`${MEMORY_PATH} contains duplicate memory IDs.`);
  return Object.freeze({
    records: Object.freeze(records),
    sourceVersion,
    legacyCount: records.filter((item) => item.scope.kind === "legacy-unscoped").length,
  });
}

function parseRecord(value: unknown, version: 1 | 2): MemoryRecord {
  if (!record(value)) throw new Error(`${MEMORY_PATH} contains an invalid record.`);
  const base = {
    id: strictString(value.id, "memory id", 128),
    content: stringUnknown(value.content, "memory content", 8_192),
    source: stringUnknown(value.source, "memory source", 2_048),
    createdAt: timestamp(value.createdAt),
  };
  if (version === 1) return Object.freeze({ ...base, scope: Object.freeze({ kind: "legacy-unscoped" }) });
  if (!record(value.scope) || (value.scope.kind !== "profile" && value.scope.kind !== "legacy-unscoped")) {
    throw new Error(`${MEMORY_PATH} contains an invalid memory scope.`);
  }
  const scope: ProfileMemoryScope | LegacyMemoryScope = value.scope.kind === "legacy-unscoped"
    ? Object.freeze({ kind: "legacy-unscoped" })
    : Object.freeze({
        kind: "profile",
        profileId: strictString(value.scope.profileId, "memory profile ID", 256),
        profileRevision: strictString(value.scope.profileRevision, "memory profile revision", 256),
        createdInSessionId: strictString(value.scope.createdInSessionId, "memory creation session", 512),
      });
  return Object.freeze({ ...base, scope });
}

function serializeMemoryDocument(records: readonly MemoryRecord[]): string {
  return `${JSON.stringify({ version: 2, records }, null, 2)}\n`;
}

async function pinnedProfile(journal: EventJournal, context: ToolContext): Promise<SessionProfileBinding> {
  const session = await journal.getSession(context.sessionId, context.signal);
  if (!session) throw new Error(`Memory authority session was not found: ${context.sessionId}.`);
  if (!session.manifest.profile) throw new Error("Explicit memory requires an accountable session with a pinned profile.");
  strictString(session.manifest.profile.profileId, "pinned memory profile ID", 256);
  strictString(session.manifest.profile.profileRevision, "pinned memory profile revision", 256);
  return session.manifest.profile;
}

function emptyDocument(): MemoryDocument {
  return Object.freeze({ records: Object.freeze([]), sourceVersion: 2, legacyCount: 0 });
}

function stringUnknown(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\u0000")) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function strictString(value: unknown, name: string, maximum: number): string {
  const text = stringUnknown(value, name, maximum);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}

function timestamp(value: unknown): string {
  const text = stringUnknown(value, "memory timestamp", 128);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new Error("memory timestamp is invalid.");
  return text;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
