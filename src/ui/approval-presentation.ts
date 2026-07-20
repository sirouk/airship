import type { JsonValue } from "../core/contracts";

export type WriteApprovalFacts = Readonly<{
  target?: string;
  disposition?: "Create" | "Replace";
  byteLength?: number;
  byteDelta?: number;
  before?: string;
  after?: string;
}>;

const MAX_PREVIEW = 1_024;

export function writeApprovalFacts(value: JsonValue): WriteApprovalFacts | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  const record = value as Record<string, JsonValue>;
  const target = stringField(record, "path", "targetPath", "file");
  const after = stringField(record, "content", "newContent", "after");
  const before = stringField(record, "oldContent", "previousContent", "before");
  const expectedRevision = record.expectedRevision;
  if (!target && after === undefined && before === undefined) return undefined;
  const beforeBytes = before === undefined ? undefined : utf8Length(before);
  const afterBytes = after === undefined ? undefined : utf8Length(after);
  return Object.freeze({
    target,
    disposition: expectedRevision === undefined || expectedRevision === null ? "Create" : "Replace",
    byteLength: afterBytes,
    byteDelta: beforeBytes === undefined || afterBytes === undefined ? undefined : afterBytes - beforeBytes,
    before: bounded(before),
    after: bounded(after),
  });
}

export function remainingApprovalTime(expiresAt: string, now = Date.now()): string {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const seconds = Math.ceil(remaining / 1_000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function stringField(record: Record<string, JsonValue>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string") return record[key];
  return undefined;
}

function bounded(value?: string): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_PREVIEW ? value : `${value.slice(0, MAX_PREVIEW)}\n… bounded preview`;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
