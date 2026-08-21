/**
 * memory.json: the document, separated from the tools that write it.
 *
 * The schema was reachable only through `memory-tools.ts`, which also carries
 * the `recall_memory`/`update_memory` definitions, the dedup rankers and the
 * registry. Any surface that merely needed to READ or WRITE the file pulled
 * all of that with it — the work bundle's memory merge measured 35 KiB of
 * chunk for a parser worth about two. The schema is one thing; the tools that
 * use it are another, and this file is the first.
 *
 * `memory-tools.ts` re-exports everything here, so no existing importer moved.
 */
import type { SessionProfileBinding } from "../core/contracts";

export const MEMORY_PATH = "/workspace/.airship/memory.json";
export const MAX_MEMORIES = 512;
export const LEGACY_MEMORY_SCOPE = "legacy-unscoped";

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

export type MemoryDocument = Readonly<{
  records: readonly MemoryRecord[];
  sourceVersion: 1 | 2;
  legacyCount: number;
}>;

export function emptyMemoryDocument(): MemoryDocument {
  return Object.freeze({ records: Object.freeze([]), sourceVersion: 2, legacyCount: 0 });
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
    legacyCount: records.filter((item) => item.scope.kind === LEGACY_MEMORY_SCOPE).length,
  });
}

function parseRecord(value: unknown, version: 1 | 2): MemoryRecord {
  if (!record(value)) throw new Error(`${MEMORY_PATH} contains an invalid record.`);
  const base = {
    id: strictMemoryString(value.id, "memory id", 128),
    content: stringUnknown(value.content, "memory content", 8_192),
    source: stringUnknown(value.source, "memory source", 2_048),
    createdAt: timestamp(value.createdAt),
  };
  if (version === 1) return Object.freeze({ ...base, scope: Object.freeze({ kind: LEGACY_MEMORY_SCOPE }) });
  if (!record(value.scope) || (value.scope.kind !== "profile" && value.scope.kind !== LEGACY_MEMORY_SCOPE)) {
    throw new Error(`${MEMORY_PATH} contains an invalid memory scope.`);
  }
  const scope: ProfileMemoryScope | LegacyMemoryScope = value.scope.kind === LEGACY_MEMORY_SCOPE
    ? Object.freeze({ kind: LEGACY_MEMORY_SCOPE })
    : Object.freeze({
        kind: "profile",
        profileId: strictMemoryString(value.scope.profileId, "memory profile ID", 256),
        profileRevision: strictMemoryString(value.scope.profileRevision, "memory profile revision", 256),
        createdInSessionId: strictMemoryString(value.scope.createdInSessionId, "memory creation session", 512),
      });
  return Object.freeze({ ...base, scope });
}

/**
 * Exported for the work bundle's memory merge, which writes this exact file
 * back after joining records in. A second serializer would be a second schema.
 */
export function serializeMemoryDocument(records: readonly MemoryRecord[]): string {
  return `${JSON.stringify({ version: 2, records }, null, 2)}\n`;
}


function stringUnknown(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\u0000")) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

/** A bounded, control-character-free string. Exported for the pinned-profile check. */
export function strictMemoryString(value: unknown, name: string, maximum: number): string {
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
