import { hasConfidentialAuthority, readConfidentialAuthority } from "./confidential-authority";
import { HashEmbeddingProvider } from "./hash-embeddings";
import { CHUTES_EMBEDDING_DIMENSIONS, ChutesEmbeddingProvider } from "./chutes-embeddings";
import type { EmbeddingProvider } from "./contracts";
import type { EmbeddingPosture } from "../core/contracts";
import {
  getBrowserCapabilityRegistry,
  semanticWasmThreadCount,
  type BrowserRuntimeCapabilityReport,
} from "../capabilities/browser-runtime";
import {
  LazySemanticWorkerEmbeddingProvider,
  type SemanticAccelerationPreference,
  type SemanticProviderState,
  type SemanticWorkerPort,
} from "./semantic-worker-provider";
import semanticWorkerUrl from "./semantic.worker.ts?worker&url";

const PREFERENCE_KEY = "airship.context.embedding.v1";

export type EmbeddingMode = "bootstrap" | "semantic" | "chutes";

/*
 * The authority lives in its own dependency-free module so the connection code
 * that installs it does not have to import this one — see the header of
 * `confidential-authority.ts`. Re-exported here because this is where every
 * reader already looks for it.
 */
export {
  hasConfidentialAuthority,
  setConfidentialAuthority,
  subscribeConfidentialAuthority,
  type ConfidentialAuthorityListener,
  type ConfidentialEmbeddingAuthority,
} from "./confidential-authority";

/**
 * The recorded choice, or nothing when the person has never made one.
 *
 * "No preference" and "prefers bootstrap" are different facts: collapsing them
 * is what left the capability probe with no branch to act on, so every device
 * stayed on hash vectors until someone found a button.
 */
export function readStoredEmbeddingMode(): EmbeddingMode | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const stored = localStorage.getItem(PREFERENCE_KEY);
    /*
     * `chutes` is admitted only when a confidential authority is installed.
     * The first generation is built on the registry-construction critical path
     * (src/tools/airship-tools.ts:115-125, an unguarded `await refreshNow()`),
     * and the bearer is memory-only — so a persisted `chutes` on a fresh page
     * load is not a dead memory index, it is a failed profile activation.
     * Treating it as "no preference" keeps the probe's answer and fails no boot.
     */
    if (stored === "chutes") return hasConfidentialAuthority() ? "chutes" : undefined;
    return stored === "semantic" || stored === "bootstrap" ? stored : undefined;
  } catch {
    // Storage can be denied by browser privacy policy even when the API is
    // present. Keep the deterministic on-device provider available.
    return undefined;
  }
}

export function readEmbeddingMode(): EmbeddingMode {
  return readStoredEmbeddingMode() ?? "bootstrap";
}

export function writeEmbeddingMode(mode: EmbeddingMode): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFERENCE_KEY, mode);
  } catch {
    // The active page may still use the selected mode; persistence is an
    // optional preference and never a prerequisite for context retrieval.
  }
}

type CapabilitySource = Pick<BrowserRuntimeCapabilityReport, "scheduling"> | undefined;

export type BrowserSemanticProviderOptions = Readonly<{
  workerFactory?: () => SemanticWorkerPort;
  /**
   * Resolved, never sampled: the default awaits the capability probe instead of
   * reading snapshot(), because a cold snapshot at first embed would latch the
   * worker onto the WASM fallback on a WebGPU-preferring host for the rest of
   * the page lifetime.
   */
  capabilities?: () => CapabilitySource | Promise<CapabilitySource>;
}>;

export function createBrowserSemanticProvider(options: BrowserSemanticProviderOptions = {}): LazySemanticWorkerEmbeddingProvider {
  const workerFactory = options.workerFactory ?? (() => {
    const workerUrl = new URL(semanticWorkerUrl, location.origin);
    const worker = new Worker(trustedSemanticWorkerUrl(workerUrl) as string, {
      type: "module",
      name: "airship-semantic-embeddings",
    });
    return worker as SemanticWorkerPort;
  });
  const capabilities = options.capabilities
    ?? (() => getBrowserCapabilityRegistry().refresh().catch(() => undefined));
  return new LazySemanticWorkerEmbeddingProvider(workerFactory, async () => {
    const scheduling = (await capabilities())?.scheduling;
    // No policy means no observation to act on. Returning undefined hands the
    // provider its own fallback rather than asserting a backend choice here.
    if (!scheduling) return undefined;
    const preference: SemanticAccelerationPreference = {
      backend: scheduling.preferredSemanticBackend === "webgpu" ? "webgpu" : "wasm",
      powerPreference: scheduling.powerPreference,
      wasmThreads: semanticWasmThreadCount(scheduling),
    };
    return Object.freeze(preference);
  });
}

let semanticWorkerPolicy: { createScriptURL(input: string): object } | undefined;
function trustedSemanticWorkerUrl(url: URL): string | object {
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(input: string): string }): { createScriptURL(input: string): object } };
  }).trustedTypes;
  if (!factory) return url.href;
  semanticWorkerPolicy ??= factory.createPolicy("airship-semantic-worker", {
    createScriptURL(input) {
      const candidate = new URL(input, location.origin);
      const sourceWorker = candidate.pathname === "/src/indexing/semantic.worker.ts" || candidate.pathname === "/src/indexing/semantic.worker.ts?worker_file&type=module";
      const builtWorkerPrefix = `${import.meta.env.BASE_URL}assets/`;
      const builtWorker = candidate.pathname.startsWith(builtWorkerPrefix) &&
        /^semantic\.worker-[A-Za-z0-9_-]+\.js$/u.test(candidate.pathname.slice(builtWorkerPrefix.length));
      if (candidate.origin !== location.origin || (!sourceWorker && !builtWorker) || candidate.hash) {
        throw new TypeError("Airship refused an unapproved semantic worker URL.");
      }
      return candidate.href;
    },
  });
  return semanticWorkerPolicy.createScriptURL(url.href);
}

/**
 * Stable provider identity for the context engine. Switching is explicit and
 * performed only between completed index generations by ClientContextRuntime.
 */
export class SwitchableEmbeddingProvider implements EmbeddingProvider {
  private readonly localDimensions: number;
  private readonly bootstrap: HashEmbeddingProvider;
  private semantic?: LazySemanticWorkerEmbeddingProvider;
  private confidential?: EmbeddingProvider;
  private mode: EmbeddingMode;

  constructor(
    dimensions = 384,
    mode: EmbeddingMode = readEmbeddingMode(),
    private readonly semanticFactory: () => LazySemanticWorkerEmbeddingProvider = createBrowserSemanticProvider,
    private readonly confidentialFactory: () => EmbeddingProvider =
      () => new ChutesEmbeddingProvider({ token: () => readConfidentialAuthority()?.() }),
  ) {
    this.localDimensions = dimensions;
    this.bootstrap = new HashEmbeddingProvider(dimensions);
    this.mode = mode;
  }

  /**
   * Per mode, because the widths differ and a mismatch is not recoverable.
   *
   * The on-device engines are 384; Qwen3-Embedding-8B is 4096
   * (`chutes-embeddings.ts:37`). `cosine()` throws on any width mismatch
   * (`flat-index.ts:85`), so reporting one fixed number here would have had the
   * engine allocate and query a 384-wide index against 4096-wide vectors — a
   * throw on the first search rather than at the moment the mode changed.
   * Switching modes rebuilds the generation (`client-context-runtime.ts`
   * `setEmbeddingMode`), so no live index ever sees this value change under it.
   */
  get dimensions(): number {
    return this.mode === "chutes" ? CHUTES_EMBEDDING_DIMENSIONS : this.localDimensions;
  }

  get id(): string {
    if (this.mode === "chutes") return this.confidentialProvider.id;
    return this.mode === "semantic" ? this.semanticProvider.id : this.bootstrap.id;
  }

  get posture(): EmbeddingPosture {
    if (this.mode === "chutes") return "confidential-remote";
    return this.mode === "semantic" ? "local-semantic" : "deterministic-bootstrap";
  }

  getMode(): EmbeddingMode { return this.mode; }
  getSemanticState(): SemanticProviderState { return this.semantic?.getState() ?? Object.freeze({ phase: "cold" }); }
  subscribeSemantic(listener: (state: SemanticProviderState) => void): () => void {
    return this.semanticProvider.subscribe(listener);
  }

  setMode(mode: EmbeddingMode): void {
    this.mode = mode;
    writeEmbeddingMode(mode);
  }

  /**
   * A mode derived from this device's capabilities rather than chosen.
   *
   * Deliberately not persisted: recording it would turn "no preference" into a
   * preference, so the probe would never run again and a device that later
   * became constrained could not be demoted. Only a person's own selection is
   * durable.
   */
  applyDerivedMode(mode: EmbeddingMode): void {
    this.mode = mode;
  }

  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    // No fallback branch. A confidential request that cannot be authorized
    // rejects with the provider's own sentence; substituting hash vectors here
    // would label 384-wide bootstrap output `confidential-remote` in the same
    // lineage the receipt prints.
    if (this.mode === "chutes") return this.confidentialProvider.embed(texts, signal);
    return this.mode === "semantic" ? this.semanticProvider.embed(texts, signal) : this.bootstrap.embed(texts, signal);
  }

  dispose(): void { this.semantic?.dispose(); }

  private get semanticProvider(): LazySemanticWorkerEmbeddingProvider {
    return this.semantic ??= this.semanticFactory();
  }

  private get confidentialProvider(): EmbeddingProvider {
    return this.confidential ??= this.confidentialFactory();
  }
}
