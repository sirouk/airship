import { describe, expect, it } from "vitest";
import { sha256 } from "../core/hash";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import type { EmbeddingProvider } from "./contracts";
import {
  ClientContextEngine,
  ClientContextStaleSnapshotError,
  ClientContextSupersededError,
} from "./client-context-engine";
import { HashEmbeddingProvider } from "./hash-embeddings";

describe("ClientContextEngine", () => {
  it("indexes a revision snapshot and exposes exact local lineage and hybrid hits", async () => {
    const workspace = new MemoryWorkspace();
    const architecture = await workspace.write("docs/architecture.md", "Confidential storage uses authenticated encrypted context pages.");
    await workspace.write("assets/diagram.png", "not really an image");
    await workspace.write(".airship/git/head.v1.json", "private Git control-plane state must never be embedded");
    await workspace.write(".airship/memory.json", "profile-private memory must never enter the shared workspace index");
    const engine = new ClientContextEngine({ workspace, dimensions: 64, maxChunkCharacters: 64, overlapCharacters: 8 });

    const generation = await engine.updateWorkspace(await workspace.list());
    const indexed = generation.candidates.find((candidate) => candidate.path === architecture.path);
    const unsupported = generation.candidates.find((candidate) => candidate.path.endsWith("diagram.png"));

    expect(engine.getState().phase).toBe("ready");
    expect(indexed).toMatchObject({ status: "indexed", revision: architecture.revision, chunks: 1 });
    expect(indexed?.contentDigest).toBe(await sha256(architecture.content));
    expect(indexed?.chunkIds[0]).toMatch(/^sha256:/u);
    expect(unsupported).toMatchObject({ status: "unsupported", chunks: 0 });
    expect(generation.candidates.some((candidate) => candidate.path.includes("/.airship/git/"))).toBe(false);
    expect(generation.candidates.some((candidate) => candidate.path === "/workspace/.airship/memory.json")).toBe(false);
    expect(generation.candidateStats).toMatchObject({ total: 2, indexedBytes: architecture.size });
    expect(generation.candidateStats.byStatus).toMatchObject({ indexed: 1, unsupported: 1, failed: 0 });
    expect(generation.chunkStats).toMatchObject({ total: 1, documents: 1 });
    expect(generation.lineage).toMatchObject({
      embeddingProvider: "airship-hash-embedding-v1-64",
      embeddingPosture: "deterministic-bootstrap",
      extractor: "airship-extension-text-v1",
      maxFileBytes: 8 * 1_024 * 1_024,
      indexFormat: "flat-client-index-v1",
      scoring: "cosine-0.72+lexical-0.28",
      persistence: "memory-only",
    });
    expect(generation.timing.totalMs).toBeGreaterThanOrEqual(0);

    const result = await engine.search("authenticated context storage", { limit: 4 });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      chunkId: indexed?.chunkIds[0],
      path: architecture.path,
      revision: architecture.revision,
      contentDigest: indexed?.contentDigest,
      chunkIndex: 0,
    });
    expect(result.queryDigest).toMatch(/^sha256:/u);
    expect(result.generationDigest).toBe(generation.lineage.generationDigest);
    expect(engine.getState().lastSearch).toMatchObject({ resultCount: 1, generationDigest: result.generationDigest });
    engine.dispose();
  });

  it("coalesces identical snapshots into one refresh generation", async () => {
    const backing = new MemoryWorkspace();
    await backing.write("README.md", "One revision should produce one staged generation.");
    const workspace = new GatedWorkspace(backing);
    const gate = workspace.blockNextList();
    const engine = new ClientContextEngine({ workspace, dimensions: 64 });
    const entries = await backing.list();

    const first = engine.updateWorkspace(entries);
    await gate.started;
    const second = engine.updateWorkspace(entries);
    gate.release();

    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left.sequence).toBe(1);
    expect(engine.getState().generation?.sequence).toBe(1);
    engine.dispose();
  });

  it("serializes overlapping refreshes and commits only the newest snapshot", async () => {
    const backing = new MemoryWorkspace();
    await backing.write("notes/live.md", "obsolete alpha context");
    const firstEntries = await backing.list();
    const workspace = new GatedWorkspace(backing);
    const gate = workspace.blockNextRead();
    const engine = new ClientContextEngine({ workspace, dimensions: 64 });

    const first = engine.updateWorkspace(firstEntries).catch((error: unknown) => error);
    await gate.started;
    const newest = await backing.write("notes/live.md", "current omega context");
    const second = engine.updateWorkspace(await backing.list());
    gate.release();

    expect(await first).toBeInstanceOf(ClientContextSupersededError);
    const generation = await second;
    expect(generation.candidates[0]).toMatchObject({ revision: newest.revision, status: "indexed" });
    expect(generation.sequence).toBe(1);
    expect(workspace.maximumConcurrentReads).toBe(1);
    const result = await engine.search("omega");
    expect(result.hits[0]).toMatchObject({ revision: newest.revision, text: "current omega context" });
    engine.dispose();
  });

  it("rejects a stale caller snapshot and recovers only from an exact revision set", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "revision one");
    const stale = await workspace.list();
    const current = await workspace.write("README.md", "revision two");
    const engine = new ClientContextEngine({ workspace, dimensions: 64 });

    await expect(engine.updateWorkspace(stale)).rejects.toBeInstanceOf(ClientContextStaleSnapshotError);
    expect(engine.getState()).toMatchObject({ phase: "error", error: { code: "CONTEXT_SNAPSHOT_STALE" } });
    expect(engine.getState().generation).toBeUndefined();

    const recovered = await engine.updateWorkspace(await workspace.list());
    expect(recovered.candidates[0]).toMatchObject({ revision: current.revision, status: "indexed" });
    expect(engine.getState().phase).toBe("ready");
    engine.dispose();
  });

  it("cancels search and fails closed when the workspace changes during a query", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("notes/search.md", "stable searchable context");
    const embeddings = new GatedQueryEmbeddings(64, "blocked query");
    const engine = new ClientContextEngine({ workspace, embeddings });
    await engine.updateWorkspace(await workspace.list());

    const controller = new AbortController();
    const cancelled = engine.search("blocked query", { signal: controller.signal }).catch((error: unknown) => error);
    await embeddings.started;
    controller.abort(new DOMException("Caller cancelled search.", "AbortError"));
    expect((await cancelled as Error).name).toBe("AbortError");
    expect(engine.getState().phase).toBe("ready");

    embeddings.reset("stale query");
    const staleSearch = engine.search("stale query").catch((error: unknown) => error);
    await embeddings.started;
    await workspace.write("notes/search.md", "a new revision landed during retrieval");
    embeddings.release();
    expect(await staleSearch).toBeInstanceOf(ClientContextStaleSnapshotError);
    expect(engine.getState().phase).toBe("error");
    engine.dispose();
  });
});

class GatedWorkspace implements WorkspacePort {
  private listGate?: Gate;
  private readGate?: Gate;
  private activeReads = 0;
  maximumConcurrentReads = 0;

  constructor(private readonly backing: WorkspacePort) {}

  blockNextList(): Gate {
    return this.listGate = createGate();
  }

  blockNextRead(): Gate {
    return this.readGate = createGate();
  }

  async list(path?: string): Promise<WorkspaceEntry[]> {
    const gate = this.listGate;
    this.listGate = undefined;
    if (gate) {
      gate.markStarted();
      await gate.wait;
    }
    return this.backing.list(path);
  }

  async read(path: string): Promise<WorkspaceFile | undefined> {
    this.activeReads += 1;
    this.maximumConcurrentReads = Math.max(this.maximumConcurrentReads, this.activeReads);
    try {
      const gate = this.readGate;
      this.readGate = undefined;
      if (gate) {
        gate.markStarted();
        await gate.wait;
      }
      return await this.backing.read(path);
    } finally {
      this.activeReads -= 1;
    }
  }

  write(path: string, content: string, options?: { expectedRevision?: string | null }): Promise<WorkspaceFile> {
    return this.backing.write(path, content, options);
  }

  remove(path: string, options?: { expectedRevision?: string }): Promise<void> {
    return this.backing.remove(path, options);
  }
}

class GatedQueryEmbeddings implements EmbeddingProvider {
  readonly base: HashEmbeddingProvider;
  readonly dimensions: number;
  readonly id: string;
  private query: string;
  private gate = createGate();

  constructor(dimensions: number, query: string) {
    this.base = new HashEmbeddingProvider(dimensions);
    this.dimensions = this.base.dimensions;
    this.id = this.base.id;
    this.query = query;
  }

  get started(): Promise<void> {
    return this.gate.started;
  }

  release(): void {
    this.gate.release();
  }

  reset(query: string): void {
    this.query = query;
    this.gate = createGate();
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 1 && texts[0] === this.query) {
      this.gate.markStarted();
      await waitForGateOrAbort(this.gate, signal);
    }
    return this.base.embed(texts, signal);
  }
}

type Gate = Readonly<{
  started: Promise<void>;
  wait: Promise<void>;
  markStarted: () => void;
  release: () => void;
}>;

function createGate(): Gate {
  let markStarted: () => void = () => undefined;
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { started, wait, markStarted, release };
}

async function waitForGateOrAbort(gate: Gate, signal?: AbortSignal): Promise<void> {
  if (!signal) return gate.wait;
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void gate.wait.then(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    });
  });
}
