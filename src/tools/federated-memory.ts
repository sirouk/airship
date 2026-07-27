import type { JsonValue, Tool, ToolContext } from "../core/contracts";
import { sha256 } from "../core/hash";
import type { DurableEvent, EventJournal } from "../core/journal";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import type { ClientContextSearchHit } from "../indexing/client-context-engine";
import type { WorkspacePort } from "../workspace/contracts";
import { memoryLineage } from "../retrieval/federated-turn-context";
import { rankProfileMemories } from "../retrieval/memory-ranking";
import { toolLineage, workspaceGenerationLineage } from "../retrieval/tool-lineage";
import { MEMORY_PATH, parseMemoryDocument } from "./memory-tools";
import type { ToolRegistry } from "./registry";

const MAX_HITS_PER_GROUP = 12;

export type FederatedMemoryResult = Readonly<{
  version: 1;
  query: string;
  queryDigest: string;
  authority: Readonly<{ sessionId: string; profileId: string; profileRevision: string }>;
  groups: readonly [ThreadGroup, ProfileGroup, WorkspaceGroup];
}>;

export type FederatedMemorySearchState = Readonly<{
  authority: object;
  query: string;
  result?: FederatedMemoryResult;
  status?: string;
  searching: boolean;
}>;

type ThreadGroup = Readonly<{
  corpus: "current-thread";
  priority: 1;
  ranking: "reverse-chronological lexical matches";
  hits: readonly Readonly<Record<string, JsonValue>>[];
}>;

type ProfileGroup = Readonly<{
  corpus: "active-profile-memory";
  priority: 2;
  ranking: "bounded BM25 relevance, recency-tiebroken; within this corpus only";
  legacyQuarantined: number;
  lineage?: JsonValue;
  hits: readonly Readonly<Record<string, JsonValue>>[];
}>;

type FederatedWorkspaceHit = Readonly<ClientContextSearchHit & {
  scoreScope: "shared-workspace-index-only";
}>;

type WorkspaceGroup = Readonly<{
  corpus: "shared-workspace-index";
  priority: 3;
  ranking: "hybrid score within this corpus only; never comparable across groups";
  generationDigest: string;
  workspaceSnapshotDigest: string;
  durationMs: number;
  completedAt: string;
  lineage?: JsonValue;
  duplicatesSuppressed: number;
  hits: readonly FederatedWorkspaceHit[];
}>;

export function registerFederatedMemoryTool(
  registry: ToolRegistry,
  workspace: WorkspacePort,
  journal: EventJournal,
  runtime: ClientContextRuntime,
): void {
  const tool: Tool = {
    definition: {
      name: "search_memory",
      description: "Search three explicit context lanes without blending scores: current thread (reverse-chronological substring), this session's pinned-profile memories (ranked, recency-tiebroken), then the shared workspace/source hybrid index. Each indexed lane reports its own generation lineage.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 8_192 },
          limitPerGroup: { type: "integer", minimum: 1, maximum: MAX_HITS_PER_GROUP },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(value, context) {
      const args = argumentsObject(value);
      const query = stringArgument(args.query, "query");
      const limit = typeof args.limitPerGroup === "number" ? args.limitPerGroup : 6;
      const result = await searchFederatedMemory({ query, limit, context, workspace, journal, runtime });
      return {
        content: JSON.stringify(result, null, 2),
        metadata: {
          scope: "federated-explicit-lanes",
          sessionId: result.authority.sessionId,
          profileId: result.authority.profileId,
          threadHits: result.groups[0].hits.length,
          profileHits: result.groups[1].hits.length,
          workspaceHits: result.groups[2].hits.length,
        },
      };
    },
  };
  registry.register(tool);
}

export async function searchFederatedMemory(args: Readonly<{
  query: string;
  limit: number;
  context: ToolContext;
  workspace: WorkspacePort;
  journal: EventJournal;
  runtime: ClientContextRuntime;
}>): Promise<FederatedMemoryResult> {
  const session = await args.journal.getSession(args.context.sessionId, args.context.signal);
  if (!session?.manifest.profile) throw new Error("Federated memory requires an accountable session with a pinned profile.");
  const profile = session.manifest.profile;
  const normalized = args.query.trim().toLocaleLowerCase();
  const events = await args.journal.readEvents(session.id, 0, args.context.signal);
  const threadHits = await threadMatches(events, normalized, args.limit);
  const file = await args.workspace.read(MEMORY_PATH);
  const document = file ? parseMemoryDocument(file.content) : undefined;
  const profileScoped = (document?.records ?? [])
    .filter((memory) => memory.scope.kind === "profile" && memory.scope.profileId === profile.profileId);
  const profileHits = await Promise.all(
    rankProfileMemories(profileScoped, args.query, { limit: args.limit })
    .map(({ record: memory }) => memory)
    .map(async (memory) => Object.freeze({
      id: memory.id,
      content: memory.content,
      source: memory.source,
      createdAt: memory.createdAt,
      contentDigest: await sha256(memory.content),
      profileId: profile.profileId,
      profileRevisionAtCreation: memory.scope.kind === "profile" ? memory.scope.profileRevision : "",
      createdInSessionId: memory.scope.kind === "profile" ? memory.scope.createdInSessionId : "",
    } satisfies Record<string, JsonValue>)));

  // The profile lane carries its own generation so a caller can re-derive which
  // memory.json revision produced these records, exactly as the turn seam does.
  const profileLineage = file && profileHits.length
    ? toolLineage(
      "airship-profile-memory-tool-v1",
      {
        sessionId: session.id,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
      },
      [await memoryLineage(file.revision, file.content)],
    )
    : undefined;

  // search() refreshes and revision-checks the workspace before and after the
  // query. Failure is propagated; stale results are never silently substituted.
  const workspaceResult = await args.runtime.search(args.query, { limit: args.limit, signal: args.context.signal });
  const workspaceGeneration = args.runtime.getState().generation;
  const workspaceLineage = workspaceGeneration
    ? toolLineage(
      "airship-workspace-tool-search-v1",
      { sessionId: session.id, workspaceId: session.manifest.workspaceId },
      [workspaceGenerationLineage(workspaceGeneration)],
    )
    : undefined;
  const seen = new Set<string>();
  let duplicatesSuppressed = 0;
  const workspaceHits: FederatedWorkspaceHit[] = [];
  for (const hit of workspaceResult.hits) {
    const key = `${hit.path}\u0000${hit.chunkId}`;
    if (seen.has(key)) { duplicatesSuppressed += 1; continue; }
    seen.add(key);
    workspaceHits.push(Object.freeze({
      ...hit,
      scoreScope: "shared-workspace-index-only",
    }));
  }
  return Object.freeze({
    version: 1,
    query: args.query,
    queryDigest: await sha256(args.query.trim()),
    authority: Object.freeze({
      sessionId: session.id,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
    }),
    groups: Object.freeze([
      Object.freeze({
        corpus: "current-thread",
        priority: 1,
        ranking: "reverse-chronological lexical matches",
        hits: Object.freeze(threadHits),
      }),
      Object.freeze({
        corpus: "active-profile-memory",
        priority: 2,
        ranking: "bounded BM25 relevance, recency-tiebroken; within this corpus only",
        legacyQuarantined: document?.legacyCount ?? 0,
        ...(profileLineage ? { lineage: profileLineage as unknown as JsonValue } : {}),
        hits: Object.freeze(profileHits),
      }),
      Object.freeze({
        corpus: "shared-workspace-index",
        priority: 3,
        ranking: "hybrid score within this corpus only; never comparable across groups",
        generationDigest: workspaceResult.generationDigest,
        workspaceSnapshotDigest: workspaceResult.workspaceSnapshotDigest,
        durationMs: workspaceResult.durationMs,
        completedAt: workspaceResult.completedAt,
        ...(workspaceLineage ? { lineage: workspaceLineage as unknown as JsonValue } : {}),
        duplicatesSuppressed,
        hits: Object.freeze(workspaceHits),
      }),
    ] as const),
  });
}

async function threadMatches(events: readonly DurableEvent[], query: string, limit: number) {
  const matches: Readonly<Record<string, JsonValue>>[] = [];
  for (const event of [...events].reverse()) {
    const text = eventText(event);
    if (!text || !text.toLocaleLowerCase().includes(query)) continue;
    matches.push(Object.freeze({
      eventId: event.eventId,
      eventDigest: event.digest,
      sequence: event.sequence,
      eventType: event.type,
      recordedAt: event.recordedAt,
      text: boundedText(text),
      textDigest: await sha256(text),
    }));
    if (matches.length >= limit) break;
  }
  return matches;
}

function eventText(event: DurableEvent): string | undefined {
  const payload = record(event.payload);
  if (event.type === "turn.requested" && typeof payload?.content === "string") return payload.content;
  if (event.type === "assistant.completed") {
    const message = record(payload?.message);
    return typeof message?.content === "string" ? message.content : undefined;
  }
  if (["tool.resulted", "tool.failed", "tool.denied"].includes(event.type) && typeof payload?.content === "string") {
    return payload.content;
  }
  return undefined;
}

function boundedText(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
}

function argumentsObject(value: JsonValue): Record<string, JsonValue> {
  const result = record(value);
  if (!result) throw new Error("Tool arguments must be an object.");
  return result as Record<string, JsonValue>;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
