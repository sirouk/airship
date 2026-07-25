import { HashEmbeddingProvider } from "./hash-embeddings";
import type { EmbeddingProvider } from "./contracts";
import {
  getBrowserCapabilityRegistry,
  type BrowserRuntimeCapabilityReport,
} from "../capabilities/browser-runtime";
import {
  LazySemanticWorkerEmbeddingProvider,
  type SemanticProviderState,
  type SemanticWorkerPort,
} from "./semantic-worker-provider";
import semanticWorkerUrl from "./semantic.worker.ts?worker&url";

const PREFERENCE_KEY = "airship.context.embedding.v1";

export type EmbeddingMode = "bootstrap" | "semantic";

export function readEmbeddingMode(): EmbeddingMode {
  if (typeof localStorage === "undefined") return "bootstrap";
  try {
    return localStorage.getItem(PREFERENCE_KEY) === "semantic" ? "semantic" : "bootstrap";
  } catch {
    // Storage can be denied by browser privacy policy even when the API is
    // present. Keep the deterministic on-device provider available.
    return "bootstrap";
  }
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

export type BrowserSemanticProviderOptions = Readonly<{
  workerFactory?: () => SemanticWorkerPort;
  capabilities?: () => Pick<BrowserRuntimeCapabilityReport, "scheduling"> | undefined;
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
  const capabilities = options.capabilities ?? (() => getBrowserCapabilityRegistry().snapshot());
  return new LazySemanticWorkerEmbeddingProvider(
    workerFactory,
    () => capabilities()?.scheduling.preferredSemanticBackend === "webgpu",
  );
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
  readonly dimensions: number;
  private readonly bootstrap: HashEmbeddingProvider;
  private semantic?: LazySemanticWorkerEmbeddingProvider;
  private mode: EmbeddingMode;

  constructor(
    dimensions = 384,
    mode: EmbeddingMode = readEmbeddingMode(),
    private readonly semanticFactory: () => LazySemanticWorkerEmbeddingProvider = createBrowserSemanticProvider,
  ) {
    this.dimensions = dimensions;
    this.bootstrap = new HashEmbeddingProvider(dimensions);
    this.mode = mode;
  }

  get id(): string { return this.mode === "semantic" ? this.semanticProvider.id : this.bootstrap.id; }
  get posture(): "deterministic-bootstrap" | "local-semantic" { return this.mode === "semantic" ? "local-semantic" : "deterministic-bootstrap"; }
  getMode(): EmbeddingMode { return this.mode; }
  getSemanticState(): SemanticProviderState { return this.semantic?.getState() ?? Object.freeze({ phase: "cold" }); }
  subscribeSemantic(listener: (state: SemanticProviderState) => void): () => void {
    return this.semanticProvider.subscribe(listener);
  }

  setMode(mode: EmbeddingMode): void {
    this.mode = mode;
    writeEmbeddingMode(mode);
  }

  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.mode === "semantic" ? this.semanticProvider.embed(texts, signal) : this.bootstrap.embed(texts, signal);
  }

  dispose(): void { this.semantic?.dispose(); }

  private get semanticProvider(): LazySemanticWorkerEmbeddingProvider {
    return this.semantic ??= this.semanticFactory();
  }
}
