import type { JsonValue, SessionProfileBinding, Tool, ToolContext } from "../core/contracts";
import { randomUuid } from "../core/id";
import type { EventJournal } from "../core/journal";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "./registry";

export const MEMORY_PATH = "/workspace/.airship/memory.json";
const MAX_MEMORIES = 512;

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

export function registerMemoryTools(
  registry: ToolRegistry,
  workspace: WorkspacePort,
  journal: EventJournal,
): void {
  const recall: Tool = {
    definition: {
      name: "recall_memory",
      description: "Search explicit memories belonging to this session's pinned profile. Workspace/source search remains separately shared; legacy unscoped records are quarantined.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 2_048 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const profile = await pinnedProfile(journal, context);
      const args = objectArguments(argumentsValue);
      const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
      const limit = typeof args.limit === "number" ? args.limit : 12;
      const file = await workspace.read(MEMORY_PATH);
      const document = file ? parseMemoryDocument(file.content) : emptyDocument();
      const records = profileRecords(document.records, profile.profileId);
      const selected = records
        .filter((record) => !query || `${record.content}\n${record.source}`.toLocaleLowerCase().includes(query))
        .slice(-limit)
        .reverse();
      return {
        content: JSON.stringify(selected, null, 2),
        metadata: {
          count: selected.length,
          total: records.length,
          scope: "profile",
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          legacyQuarantined: document.legacyCount,
          revision: file?.revision ?? null,
        },
      };
    },
  };

  const update: Tool = {
    definition: {
      name: "update_memory",
      description: "Remember or forget one explicit memory in this session's pinned profile scope. Profile identity is derived from the accountable session, never tool arguments.",
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
      const action = stringArgument(args.action, "action");
      const current = await workspace.read(MEMORY_PATH);
      const document = current ? parseMemoryDocument(current.content) : emptyDocument();
      let next: MemoryRecord[];
      let message: string;
      if (action === "remember") {
        if (document.records.length >= MAX_MEMORIES) throw new Error(`Memory is at its ${MAX_MEMORIES}-record limit.`);
        const record: MemoryRecord = Object.freeze({
          id: randomUuid(),
          content: stringArgument(args.content, "content"),
          source: stringArgument(args.source, "source"),
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
        const id = stringArgument(args.id, "id");
        const owned = document.records.some((record) =>
          record.id === id && record.scope.kind === "profile" && record.scope.profileId === profile.profileId,
        );
        if (!owned) throw new Error(`Memory not found in pinned profile ${profile.profileId}: ${id}.`);
        next = document.records.filter((record) => record.id !== id);
        message = `Forgot memory ${id} from pinned profile ${profile.profileId}.`;
      } else {
        throw new Error(`Unsupported memory action: ${action}.`);
      }
      const written = await workspace.write(MEMORY_PATH, serializeMemoryDocument(next), {
        expectedRevision: current?.revision ?? null,
      });
      return {
        content: message,
        metadata: {
          count: profileRecords(next, profile.profileId).length,
          scope: "profile",
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          legacyQuarantined: next.filter((record) => record.scope.kind === "legacy-unscoped").length,
          schemaVersion: 2,
          revision: written.revision,
          path: written.path,
        },
      };
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

function profileRecords(records: readonly MemoryRecord[], profileId: string): MemoryRecord[] {
  return records.filter((item) => item.scope.kind === "profile" && item.scope.profileId === profileId);
}

function emptyDocument(): MemoryDocument {
  return Object.freeze({ records: Object.freeze([]), sourceVersion: 2, legacyCount: 0 });
}

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!record(value)) throw new Error("Tool arguments must be an object.");
  return value as Record<string, JsonValue>;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
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
