import { sha256 } from "../core/hash";
import { isWorkspaceControlPlanePath } from "../workspace/contracts";
import { isWorkspaceBinaryEnvelope } from "../workspace/content-codec";
import type {
  ClientIndex,
  EmbeddedChunk,
  IndexCandidate,
  IndexSnapshot,
  IndexerOptions,
  SearchHit,
} from "./contracts";
import { tokenize } from "./hash-embeddings";

/** The mount every workspace path shares, stated once. */
const WORKSPACE_ROOT_PREFIX = "/workspace/";

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
  private readonly embeddingBatchSize;
  private readonly maxIndexingConcurrency;
  private readonly cooperativeYieldIntervalMs;
  private readonly clock;
  private readonly yieldControl;
  private lastYieldAt;
  private readonly indexedRevisions = new Map<string, string>();

  constructor(options: IndexerOptions) {
    this.workspace = options.workspace;
    this.embeddings = options.embeddings;
    this.index = options.index;
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
    this.maxChunkCharacters = options.maxChunkCharacters ?? 1_200;
    this.overlapCharacters = options.overlapCharacters ?? 160;
    if (this.overlapCharacters >= this.maxChunkCharacters) throw new Error("Chunk overlap must be smaller than chunk size.");
    this.embeddingBatchSize = boundedInteger(options.scheduling?.embeddingBatchSize ?? 512, 1, 512, "Embedding batch size");
    this.maxIndexingConcurrency = boundedInteger(options.scheduling?.maxIndexingConcurrency ?? 1, 1, 8, "Indexing concurrency");
    this.cooperativeYieldIntervalMs = boundedInteger(options.scheduling?.cooperativeYieldIntervalMs ?? 0, 0, 1_000, "Cooperative yield interval");
    this.clock = options.scheduling?.clock ?? monotonicNow;
    this.yieldControl = options.scheduling?.yieldControl ?? yieldToBrowser;
    this.lastYieldAt = this.clock();
  }

  async discover(): Promise<IndexCandidate[]> {
    const entries = await this.workspace.list("/workspace");
    return entries.filter((entry) => !isWorkspaceControlPlanePath(entry.path)).map((entry) => {
      // The suffix table labels a content type; it is not the text/binary
      // decision. That decision is made on the actual bytes in indexCandidate,
      // so an unknown suffix — .cpp, .rb, .sh, Dockerfile — proceeds as plain
      // text rather than being refused sight unseen.
      const contentType = contentTypeFor(entry.path) ?? "text/plain";
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

    return concurrentMap(candidates, this.maxIndexingConcurrency, async (candidate) => {
      if (signal?.aborted) throw signal.reason;
      const result = await this.indexCandidate(candidate, signal);
      await this.cooperativeCheckpoint(signal);
      return result;
    });
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

  private async indexCandidate(candidate: IndexCandidate, signal?: AbortSignal): Promise<IndexCandidate> {
    if (candidate.status === "unsupported" || candidate.status === "too-large" || candidate.status === "indexed") return candidate;
    try {
      const file = await this.workspace.read(candidate.path);
      if (!file) return { ...candidate, status: "failed", reason: "Workspace file disappeared during indexing." };
      if (isWorkspaceBinaryEnvelope(file.content)) {
        await this.index.removeByPath(file.path);
        this.indexedRevisions.delete(file.path);
        return { ...candidate, status: "unsupported", reason: "Opaque binary bytes are preserved but never decoded as model context." };
      }
      const texts = chunkText(file.content, this.maxChunkCharacters, this.overlapCharacters);
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += this.embeddingBatchSize) {
        if (signal?.aborted) throw signal.reason;
        const batch = texts.slice(start, start + this.embeddingBatchSize);
        const embedded = await this.embeddings.embed(batch, signal);
        if (embedded.length !== batch.length) throw new Error("Embedding provider returned the wrong number of vectors.");
        vectors.push(...embedded);
        await this.cooperativeCheckpoint(signal);
      }
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
          tokens: chunkSearchTokens(file.path, text),
          vector: vectors[chunkIndex]!,
        })),
      );
      await this.index.removeByPath(file.path);
      await this.index.upsert(chunks);
      this.indexedRevisions.set(file.path, file.revision);
      return { ...candidate, status: "indexed", reason: "Indexed on this device.", chunks: chunks.length };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return {
        ...candidate,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async cooperativeCheckpoint(signal?: AbortSignal): Promise<void> {
    const now = this.clock();
    if (this.cooperativeYieldIntervalMs === 0 || now - this.lastYieldAt < this.cooperativeYieldIntervalMs) return;
    await this.yieldControl();
    this.lastYieldAt = this.clock();
    if (signal?.aborted) throw signal.reason;
  }
}

/**
 * A chunk is searchable by its own name, not only by its prose.
 *
 * Measured: the Memory route's own suggestion chip — aria-label "Search memory
 * for retrieval, from this page's workspace source", minted from the path
 * notes/retrieval.md — returned "No memory matched “retrieval”" while the Index
 * panel on the same screen read "INDEXED notes/retrieval.md · 1 chunk". The chip
 * is a claim about the corpus and the corpus indexed only the file's body, so
 * the two disagreed by construction.
 *
 * Path tokens are lexical evidence of exactly the kind a body word is — the file
 * is literally named that — so they join the token set the lexical score reads,
 * deduplicated so a word in both places is not counted twice. The dense vector
 * still embeds the text alone: a filename is not prose, and it must not move
 * what a chunk is *about*.
 */
export function chunkSearchTokens(path: string, text: string): string[] {
  const tokens = tokenize(text);
  const seen = new Set(tokens);
  // The mount point is not part of any file's name: tokenizing the whole
  // absolute path would put "workspace" in every chunk and make it a term that
  // matches the entire corpus lexically.
  const named = path.startsWith(WORKSPACE_ROOT_PREFIX) ? path.slice(WORKSPACE_ROOT_PREFIX.length) : path;
  for (const token of tokenize(named)) {
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
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

async function concurrentMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is invalid.`);
  return value;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
