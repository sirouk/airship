import type { EmbeddedChunk } from "../indexing/contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_EXPERT_BLOCK_BYTES = 16 * 1024 * 1024;

export type StoredContextRecord = {
  chunkId: string;
  path: string;
  revision: string;
  text: string;
  tokens: string[];
  vector: number[];
};

export type StoredExpertBlock = {
  version: 1;
  records: StoredContextRecord[];
};

export function encodeExpertBlock(chunks: EmbeddedChunk[]): Uint8Array {
  const block: StoredExpertBlock = {
    version: 1,
    records: chunks.map((chunk) => ({
      chunkId: chunk.id,
      path: chunk.path,
      revision: chunk.revision,
      text: chunk.text,
      tokens: [...chunk.tokens],
      vector: [...chunk.vector],
    })),
  };
  const bytes = encoder.encode(JSON.stringify(block));
  if (bytes.byteLength > MAX_EXPERT_BLOCK_BYTES) throw new Error("Context expert block exceeds the client limit.");
  return bytes;
}

export function decodeExpertBlock(bytes: Uint8Array, dimensions: number): StoredExpertBlock {
  if (bytes.byteLength > MAX_EXPERT_BLOCK_BYTES) throw new Error("Context expert block exceeds the client limit.");
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context expert block.");
  const block = value as Record<string, unknown>;
  if (block.version !== 1 || !Array.isArray(block.records)) throw new Error("Unsupported context expert block.");
  const records = block.records.map((record) => parseRecord(record, dimensions));
  return { version: 1, records };
}

function parseRecord(value: unknown, dimensions: number): StoredContextRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context record.");
  const record = value as Record<string, unknown>;
  if (
    typeof record.chunkId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.revision !== "string" ||
    typeof record.text !== "string" ||
    !Array.isArray(record.tokens) ||
    !record.tokens.every((token) => typeof token === "string") ||
    !Array.isArray(record.vector) ||
    record.vector.length !== dimensions ||
    !record.vector.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    throw new Error("Invalid context record schema.");
  }
  return {
    chunkId: record.chunkId,
    path: record.path,
    revision: record.revision,
    text: record.text,
    tokens: record.tokens,
    vector: record.vector,
  };
}

