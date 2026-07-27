import { randomUuid } from "../../core/id";

export const COMPANION_PROTOCOL_VERSION = 1;

export type CompanionStorageCapability = Readonly<{
  state: "available" | "unavailable";
  enabled: boolean;
  backend: "extension-indexeddb" | "none";
  durability: "extension-origin-persistent" | "none";
  boundary: "ciphertext-cache-only";
  maxRecordBytes: number;
  maxCacheBytes: number;
  maxRecords: number;
  usageBytes?: number;
  quotaBytes?: number;
  records?: number;
  reason?: string;
}>;

export type CompanionComputeCapability = Readonly<{
  state: "available" | "unavailable";
  execution: "extension-background";
  operations: readonly ("sha256" | "cosine-top-k")[];
  maxVectorBytes: number;
  maxCandidates: number;
  maxDimensions: number;
  reason?: string;
}>;

export type CompanionCapabilities = Readonly<{
  storage: CompanionStorageCapability;
  compute: CompanionComputeCapability;
}>;

export type CompanionHandshakeResult = Readonly<
  | { kind: "answered"; version: string; capabilities: CompanionCapabilities; elapsedMs: number }
  | { kind: "silent"; deadlineMs: number }
  | { kind: "unsupported"; detail: string }
  | { kind: "malformed"; detail: string }
>;

type CompanionRequestFields =
  | Readonly<{ kind: "hello" }>
  | Readonly<{
      kind: "cache";
      operation: "get" | "put" | "remove" | "stats" | "list";
      namespace: string;
      key?: string;
      data?: string;
      digest?: string;
      ciphertext?: true;
    }>
  | Readonly<{ kind: "compute"; operation: "sha256"; data: string }>
  | Readonly<{
      kind: "compute";
      operation: "cosine-top-k";
      query: string;
      candidates: readonly Readonly<{ id: string; vector: string }>[];
      dimensions: number;
      topK: number;
    }>;

type CompanionReply =
  | Readonly<{
      airshipCompanion: 1;
      from: "extension";
      id: string;
      kind: "hello";
      version: string;
      capabilities: CompanionCapabilities;
    }>
  | Readonly<{
      airshipCompanion: 1;
      from: "extension";
      id: string;
      kind: "result";
      result: unknown;
    }>
  | Readonly<{
      airshipCompanion: 1;
      from: "extension";
      id: string;
      kind: "error";
      code: string;
      message: string;
    }>;

export class CompanionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CompanionError";
  }
}

export class PageCompanionClient {
  readonly #window: Window;
  readonly #origin: string;
  readonly #pending = new Map<string, Readonly<{
    accept: (reply: CompanionReply) => void;
    fail: (error: CompanionError) => void;
  }>>();
  readonly #listener = (event: MessageEvent<unknown>): void => this.#receive(event);
  #listening = false;

  constructor(windowLike: Window, origin: string) {
    this.#window = windowLike;
    this.#origin = origin;
  }

  async handshake(deadlineMs = 1_500): Promise<CompanionHandshakeResult> {
    const startedAt = performance.now();
    try {
      const reply = await this.#exchange({ kind: "hello" }, deadlineMs);
      if (reply.kind !== "hello") {
        return Object.freeze({ kind: "malformed", detail: `A ${reply.kind} reply answered the companion handshake.` });
      }
      return Object.freeze({
        kind: "answered",
        version: reply.version,
        capabilities: reply.capabilities,
        elapsedMs: Math.max(0, performance.now() - startedAt),
      });
    } catch (error) {
      if (error instanceof CompanionError && error.code === "companion-timeout") {
        return Object.freeze({ kind: "silent", deadlineMs });
      }
      return Object.freeze({
        kind: "malformed",
        detail: error instanceof Error ? error.message : "The companion handshake failed.",
      });
    }
  }

  async cacheStats(namespace: string): Promise<Readonly<{ records: number; bytes: number }>> {
    return this.#result({
      kind: "cache",
      operation: "stats",
      namespace,
    }) as Promise<Readonly<{ records: number; bytes: number }>>;
  }

  async cacheGet(namespace: string, key: string): Promise<
    Readonly<{ found: false }> | Readonly<{ found: true; data: string; digest: string; bytes: number }>
  > {
    return this.#result({ kind: "cache", operation: "get", namespace, key }) as Promise<
      Readonly<{ found: false }> | Readonly<{ found: true; data: string; digest: string; bytes: number }>
    >;
  }

  async cacheList(namespace: string): Promise<
    Readonly<{ pages: readonly Readonly<{ key: string; bytes: number }>[] }>
  > {
    return this.#result({ kind: "cache", operation: "list", namespace }) as Promise<
      Readonly<{ pages: readonly Readonly<{ key: string; bytes: number }>[] }>
    >;
  }

  async cachePut(
    namespace: string,
    key: string,
    data: string,
    digest?: string,
  ): Promise<Readonly<{ stored: true; digest: string }>> {
    return this.#result({
      kind: "cache",
      operation: "put",
      namespace,
      key,
      data,
      ...(digest ? { digest } : {}),
      ciphertext: true,
    }) as Promise<Readonly<{ stored: true; digest: string }>>;
  }

  async cacheRemove(namespace: string, key: string): Promise<void> {
    await this.#result({ kind: "cache", operation: "remove", namespace, key });
  }

  async sha256(data: string): Promise<Readonly<{ digest: string; bytes: number }>> {
    return this.#result({ kind: "compute", operation: "sha256", data }) as Promise<
      Readonly<{ digest: string; bytes: number }>
    >;
  }

  async cosineTopK(input: Readonly<{
    query: string;
    candidates: readonly Readonly<{ id: string; vector: string }>[];
    dimensions: number;
    topK: number;
  }>): Promise<Readonly<{ matches: readonly Readonly<{ id: string; score: number }>[] }>> {
    return this.#result({ kind: "compute", operation: "cosine-top-k", ...input }) as Promise<
      Readonly<{ matches: readonly Readonly<{ id: string; score: number }>[] }>
    >;
  }

  async #result(request: CompanionRequestFields): Promise<unknown> {
    const reply = await this.#exchange(request, 30_000);
    if (reply.kind !== "result") {
      throw new CompanionError("companion-protocol", `A ${reply.kind} reply answered a companion operation.`);
    }
    return reply.result;
  }

  #exchange(request: CompanionRequestFields, deadlineMs: number): Promise<CompanionReply> {
    if (this.#pending.size >= 8) {
      return Promise.reject(new CompanionError("companion-busy", "Too many companion operations are in flight."));
    }
    const id = randomUuid();
    this.#listen();
    return new Promise((resolve, reject) => {
      const timer = this.#window.setTimeout(() => {
        this.#pending.delete(id);
        this.#unlistenWhenIdle();
        reject(new CompanionError("companion-timeout", "The Airship Companion did not answer in time."));
      }, deadlineMs);
      this.#pending.set(id, Object.freeze({
        accept: (reply) => {
          this.#window.clearTimeout(timer);
          this.#pending.delete(id);
          this.#unlistenWhenIdle();
          if (reply.kind === "error") {
            reject(new CompanionError(reply.code, reply.message));
            return;
          }
          resolve(reply);
        },
        fail: (error) => {
          this.#window.clearTimeout(timer);
          this.#pending.delete(id);
          this.#unlistenWhenIdle();
          reject(error);
        },
      }));
      try {
        this.#window.postMessage(Object.freeze({
          airshipCompanion: COMPANION_PROTOCOL_VERSION,
          from: "page" as const,
          id,
          ...request,
        }), this.#origin);
      } catch (error) {
        this.#pending.get(id)?.fail(new CompanionError(
          "companion-send-failed",
          "The Airship Companion request could not be sent.",
          { cause: error },
        ));
      }
    });
  }

  #receive(event: MessageEvent<unknown>): void {
    if (event.source !== this.#window || event.origin !== this.#origin) return;
    const reply = parseCompanionReply(event.data);
    if (!reply) return;
    this.#pending.get(reply.id)?.accept(reply);
  }

  #listen(): void {
    if (this.#listening) return;
    this.#window.addEventListener("message", this.#listener);
    this.#listening = true;
  }

  #unlistenWhenIdle(): void {
    if (!this.#listening || this.#pending.size > 0) return;
    this.#window.removeEventListener("message", this.#listener);
    this.#listening = false;
  }
}

let pageClient: PageCompanionClient | undefined;

export function pageCompanionClient(): PageCompanionClient | undefined {
  if (typeof window === "undefined" || !window.location?.origin) return undefined;
  pageClient ??= new PageCompanionClient(window, window.location.origin);
  return pageClient;
}

function parseCompanionReply(value: unknown): CompanionReply | undefined {
  if (!isRecord(value)
    || value.airshipCompanion !== COMPANION_PROTOCOL_VERSION
    || value.from !== "extension"
    || typeof value.id !== "string"
  ) return undefined;
  if (value.kind === "error" && typeof value.code === "string" && typeof value.message === "string") {
    return value as CompanionReply;
  }
  if (value.kind === "result" && "result" in value) return value as CompanionReply;
  if (
    value.kind === "hello"
    && typeof value.version === "string"
    && isCompanionCapabilities(value.capabilities)
  ) return value as CompanionReply;
  return undefined;
}

function isCompanionCapabilities(value: unknown): value is CompanionCapabilities {
  if (!isRecord(value) || !isRecord(value.storage) || !isRecord(value.compute)) return false;
  return (value.storage.state === "available" || value.storage.state === "unavailable")
    && typeof value.storage.enabled === "boolean"
    && value.storage.boundary === "ciphertext-cache-only"
    && (value.compute.state === "available" || value.compute.state === "unavailable")
    && value.compute.execution === "extension-background"
    && Array.isArray(value.compute.operations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
