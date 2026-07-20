import { sha256 } from "../core/hash";
import { isWorkspaceControlPlanePath } from "../workspace/contracts";
import type {
  ClientIndex,
  EmbeddedChunk,
  IndexCandidate,
  IndexSnapshot,
  IndexerOptions,
  SearchHit,
} from "./contracts";
import { tokenize } from "./hash-embeddings";

const INDEXABLE_EXTENSIONS = new Map<string, string>([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".mdx", "text/markdown"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript-jsx"],
  [".js", "text/javascript"],
  [".jsx", "text/javascript-jsx"],
  [".py", "text/x-python"],
  [".rs", "text/x-rust"],
  [".go", "text/x-go"],
  [".java", "text/x-java"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".toml", "application/toml"],
  [".xml", "application/xml"],
]);

export class IncrementalWorkspaceIndexer {
  private readonly workspace;
  private readonly embeddings;
  private readonly index: ClientIndex;
  private readonly maxFileBytes;
  private readonly maxChunkCharacters;
  private readonly overlapCharacters;
  private readonly indexedRevisions = new Map<string, string>();

  constructor(options: IndexerOptions) {
    this.workspace = options.workspace;
    this.embeddings = options.embeddings;
    this.index = options.index;
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
    this.maxChunkCharacters = options.maxChunkCharacters ?? 1_200;
    this.overlapCharacters = options.overlapCharacters ?? 160;
    if (this.overlapCharacters >= this.maxChunkCharacters) throw new Error("Chunk overlap must be smaller than chunk size.");
  }

  async discover(): Promise<IndexCandidate[]> {
    const entries = await this.workspace.list("/workspace");
    return entries.filter((entry) => !isWorkspaceControlPlanePath(entry.path)).map((entry) => {
      const contentType = contentTypeFor(entry.path);
      if (!contentType) {
        return { ...entry, status: "unsupported", reason: "No client extractor is registered for this file type." };
      }
      if (entry.size > this.maxFileBytes) {
        return { ...entry, contentType, status: "too-large", reason: `File exceeds ${this.maxFileBytes} bytes.` };
      }
      const previous = this.indexedRevisions.get(entry.path);
      return {
        ...entry,
        contentType,
        status: previous === entry.revision ? "indexed" : previous ? "changed" : "ready",
        reason: previous === entry.revision ? "Index is current." : "Ready for on-device extraction and embedding.",
      };
    });
  }

  async refresh(signal?: AbortSignal): Promise<IndexCandidate[]> {
    const candidates = await this.discover();
    const visiblePaths = new Set(candidates.map((candidate) => candidate.path));
    for (const path of this.indexedRevisions.keys()) {
      if (!visiblePaths.has(path)) {
        await this.index.removeByPath(path);
        this.indexedRevisions.delete(path);
      }
    }

    const results: IndexCandidate[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) throw signal.reason;
      if (candidate.status === "unsupported" || candidate.status === "too-large" || candidate.status === "indexed") {
        results.push(candidate);
        continue;
      }
      try {
        const file = await this.workspace.read(candidate.path);
        if (!file) continue;
        const texts = chunkText(file.content, this.maxChunkCharacters, this.overlapCharacters);
        const vectors = await this.embeddings.embed(texts, signal);
        if (vectors.length !== texts.length) throw new Error("Embedding provider returned the wrong number of vectors.");
        const contentDigest = await sha256(file.content);
        const chunks: EmbeddedChunk[] = await Promise.all(
          texts.map(async (text, chunkIndex) => ({
            id: await sha256(`${file.path}\0${file.revision}\0${chunkIndex}\0${text}`),
            path: file.path,
            revision: file.revision,
            contentDigest,
            chunkIndex,
            text,
            tokens: tokenize(text),
            vector: vectors[chunkIndex],
          })),
        );
        await this.index.removeByPath(file.path);
        await this.index.upsert(chunks);
        this.indexedRevisions.set(file.path, file.revision);
        results.push({ ...candidate, status: "indexed", reason: "Indexed on this device.", chunks: chunks.length });
      } catch (error) {
        results.push({
          ...candidate,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async search(query: string, limit = 8, signal?: AbortSignal): Promise<SearchHit[]> {
    const [vector] = await this.embeddings.embed([query], signal);
    return this.index.search(vector, tokenize(query), limit);
  }

  async exportSnapshot(): Promise<IndexSnapshot> {
    const chunks = await this.index.all();
    return {
      version: 1,
      embeddingProvider: this.embeddings.id,
      dimensions: this.embeddings.dimensions,
      createdAt: new Date().toISOString(),
      chunks: chunks.map((chunk) => ({ ...chunk, vector: Array.from(chunk.vector) })),
    };
  }

  async importSnapshot(snapshot: IndexSnapshot): Promise<void> {
    if (
      snapshot.version !== 1 ||
      snapshot.embeddingProvider !== this.embeddings.id ||
      snapshot.dimensions !== this.embeddings.dimensions
    ) {
      throw new Error("Index snapshot uses an incompatible embedding model or format.");
    }
    await this.index.clear();
    const chunks = snapshot.chunks.map((chunk) => ({ ...chunk, vector: new Float32Array(chunk.vector) }));
    await this.index.upsert(chunks);
    this.indexedRevisions.clear();
    for (const chunk of chunks) this.indexedRevisions.set(chunk.path, chunk.revision);
  }
}

export function chunkText(text: string, maxCharacters = 1_200, overlapCharacters = 160): string[] {
  const normalized = text.replaceAll("\r\n", "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxCharacters);
    if (end < normalized.length) {
      const breakAt = Math.max(normalized.lastIndexOf("\n\n", end), normalized.lastIndexOf("\n", end));
      if (breakAt > start + Math.floor(maxCharacters * 0.55)) end = breakAt;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapCharacters);
  }
  return chunks;
}

function contentTypeFor(path: string): string | undefined {
  const lower = path.toLocaleLowerCase();
  for (const [extension, contentType] of INDEXABLE_EXTENSIONS) {
    if (lower.endsWith(extension)) return contentType;
  }
  return undefined;
}
