import { hasConfidentialAuthority, readConfidentialAuthority } from "./confidential-authority";
import { HashEmbeddingProvider } from "./hash-embeddings";
import { ChutesEmbeddingProvider, measureEmbeddingWidth } from "./chutes-embeddings";
import {
  discoverChutesEmbeddingModels,
  type ChutesEmbeddingCatalog,
} from "./chutes-embedding-catalog";
import { readConfidentialEmbeddingChoice } from "./confidential-embedding-choice";
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
  type ConfidentialEmbeddingInvocation,
} from "./confidential-authority";

/**
 * What discovery found, for the screen that offers the choice.
 *
 * Exposed because "Confidential" used to be a button naming one model in a
 * constant. How many embedding deployments Chutes actually publishes, and which
 * one an index was built against, are facts the person choosing is entitled to
 * — and they change without this repository being touched.
 */
export type ConfidentialEmbeddingReadiness = Readonly<{
  catalog: ChutesEmbeddingCatalog;
  modelId: string;
  dimensions: number;
}>;

/**
 * Discover an embedding deployment and measure its width, in that order.
 *
 * Both halves are questions to Chutes. The catalog says which chutes embed and
 * what path inside them speaks the OpenAI shape; the width probe takes one real
 * vector from the chosen deployment and counts it. Only then does a provider
 * exist, because a provider that does not know its width cannot refuse a wrong
 * one — and refusing a wrong one is the guarantee the index depends on.
 */
export async function prepareConfidentialEmbeddings(
  signal?: AbortSignal,
): Promise<{ provider: ChutesEmbeddingProvider; readiness: ConfidentialEmbeddingReadiness }> {
  const catalog = await discoverChutesEmbeddingModels(signal ? { signal } : {});
  /*
   * A recorded choice outranks the automatic pick, and only a recorded choice
   * does. When Chutes publishes one usable embedding chute there is nothing to
   * decide and nobody is asked; when it publishes several, the tie was being
   * broken by whichever one was warm at that instant, which is not a basis for
   * deciding where a corpus lives. An id that no longer appears in the catalog
   * loses here rather than throwing — a retired deployment is not an error.
   */
  const chosen = readConfidentialEmbeddingChoice();
  // Prefer a deployment with a live instance; a cold one still works, it just
  // pays a scale-up. Order is otherwise the catalog's, which is stable by id.
  const model = (chosen ? catalog.models.find((candidate) => candidate.id === chosen) : undefined)
    ?? catalog.models.find((candidate) => candidate.hot)
    ?? catalog.models[0];
  if (!model) {
    throw new Error(
      catalog.declined > 0
        ? `Chutes lists ${catalog.declined} embedding chute${catalog.declined === 1 ? "" : "s"}, but none of them is confidential compute with an OpenAI-compatible embeddings path, so none can hold this corpus.`
        : "Chutes lists no embedding chutes, so confidential embeddings have nothing to run on.",
    );
  }
  const dimensions = await measureEmbeddingWidth(readConfidentialAuthority, model, signal);
  const provider = new ChutesEmbeddingProvider({
    invoker: readConfidentialAuthority,
    model,
    dimensions,
  });
  return {
    provider,
    readiness: Object.freeze({ catalog, modelId: model.id, dimensions }),
  };
}

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
  private confidentialReadiness?: ConfidentialEmbeddingReadiness;
  private confidentialPreparation?: Promise<void>;
  private mode: EmbeddingMode;

  constructor(
    dimensions = 384,
    mode: EmbeddingMode = readEmbeddingMode(),
    private readonly semanticFactory: () => LazySemanticWorkerEmbeddingProvider = createBrowserSemanticProvider,
    private readonly confidentialFactory: (signal?: AbortSignal) => Promise<{
      provider: EmbeddingProvider;
      readiness: ConfidentialEmbeddingReadiness;
    }> = prepareConfidentialEmbeddings,
  ) {
    this.localDimensions = dimensions;
    this.bootstrap = new HashEmbeddingProvider(dimensions);
    this.mode = mode;
  }

  /**
   * Per mode, because the widths differ and a mismatch is not recoverable.
   *
   * The on-device engines are 384. The confidential one is whatever the
   * discovered deployment measured at — 4096 for Qwen3-Embedding-8B today, and
   * that is a fact about that model rather than about embeddings, so it is not
   * written down here. `cosine()` throws on any width mismatch
   * (`flat-index.ts:85`), so reporting one fixed number would have had the
   * engine query a 384-wide index against wider vectors — a throw on the first
   * search rather than at the moment the mode changed. Switching modes rebuilds
   * the generation (`client-context-runtime.ts` `setEmbeddingMode`), so no live
   * index ever sees this value change under it.
   *
   * Zero before discovery answers, which is honest and not inert: the snapshot
   * comparison in `incremental-indexer.ts` treats a changed width as a rebuild,
   * and no generation is ever recorded at zero because recording one requires an
   * embed, and an embed requires the width.
   */
  get dimensions(): number {
    if (this.mode !== "chutes") return this.localDimensions;
    return this.confidentialReadiness?.dimensions ?? 0;
  }

  /** What discovery found, once it has. */
  getConfidentialReadiness(): ConfidentialEmbeddingReadiness | undefined {
    return this.confidentialReadiness;
  }

  /**
   * Resolve everything the confidential engine needs before it is switched into.
   *
   * Called by `ClientContextRuntime.setEmbeddingMode` before the switch commits,
   * so a catalog that cannot be read or a deployment that will not answer a
   * width probe refuses the change with its own sentence instead of leaving the
   * index in a mode that cannot embed.
   */
  async prepare(mode: EmbeddingMode, signal?: AbortSignal): Promise<void> {
    if (mode !== "chutes" || this.confidential) return;
    this.confidentialPreparation ??= (async () => {
      try {
        const prepared = await this.confidentialFactory(signal);
        this.confidential = prepared.provider;
        this.confidentialReadiness = prepared.readiness;
      } finally {
        // Cleared either way: a failed discovery must be retryable when the
        // person presses again, and a succeeded one has nothing left to await.
        this.confidentialPreparation = undefined;
      }
    })();
    return this.confidentialPreparation;
  }

  get id(): string {
    if (this.mode === "chutes") return this.confidential?.id ?? "chutes:undiscovered";
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

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    // No fallback branch. A confidential request that cannot be authorized
    // rejects with the provider's own sentence; substituting hash vectors here
    // would label 384-wide bootstrap output `confidential-remote` in the same
    // lineage the receipt prints.
    if (this.mode === "chutes") {
      // Discovery is idempotent and normally already done by `prepare`. Doing it
      // here too means a restored `chutes` preference on a fresh page load — a
      // path with no button press in it — embeds against a discovered
      // deployment rather than failing for want of one.
      await this.prepare("chutes", signal);
      if (!this.confidential) throw new Error("Confidential embeddings were not discovered.");
      return this.confidential.embed(texts, signal);
    }
    return this.mode === "semantic" ? this.semanticProvider.embed(texts, signal) : this.bootstrap.embed(texts, signal);
  }

  dispose(): void { this.semantic?.dispose(); }

  private get semanticProvider(): LazySemanticWorkerEmbeddingProvider {
    return this.semantic ??= this.semanticFactory();
  }
}
