/**
 * The prime kernel host: the per-job JavaScript worker lifecycle authority
 * for the RLM execution kernel. It owns:
 *   - worker boot + trusted worker-url construction + ready handshake;
 *   - a serialized job queue (REPL fidelity: one cell at a time);
 *   - streaming job events to listeners and captured, budgeted results;
 *   - the tool bridge: every pat.call is routed to the host bridge port
 *     where the session authority applies approval, identity, and
 *     journaling policy — the kernel never decides;
 *   - cooperative cancellation first, hard termination second;
 *     crash/reset reporting is always explicit, never hidden;
 *   - namespace reset on restart is reported as a named event so the
 *     session authority can surface it in the transcript.
 *
 * Layering: kernel-host must not import from airship src/tools or
 * src/approvals; the bridge port is the entire seam.
 */

import primeKernelWorkerUrl from "./prime-kernel-worker.ts?worker&url";
import { createKernelProtocolToken } from "./kernel-worker-source";
import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelBudgets,
  KernelEngine,
  KernelEngineDescription,
  KernelJobEvent,
  KernelJobResult,
  KernelJobSpec,
  KernelState,
} from "./kernel-contract";
import {
  DEFAULT_KERNEL_BUDGETS,
  KERNEL_PROTOCOL_TOKEN_BYTES,
  KERNEL_STREAM_FRAME_OVERHEAD_CHARS,
  MAX_KERNEL_JOB_ID_CHARS,
  MAX_KERNEL_JSON_DEPTH,
  MAX_KERNEL_JSON_NODES,
  MAX_KERNEL_LABEL_CHARS,
  MAX_KERNEL_STREAM_FRAMES,
  MAX_KERNEL_TOOL_NAME_CHARS,
} from "./kernel-contract";

export type KernelBridgePort = Readonly<{
  /** Route one tool call from kernel code. Approval + journaling policy live on the far side of this port. */
  call(request: KernelBridgeCallRequest, label?: string): Promise<KernelBridgeCallResult>;
}>;

export type KernelHostPorts = Readonly<{
  bridge: KernelBridgePort;
  /** Override worker construction for host-authority tests. */
  workerFactory?: () => KernelWorkerLike;
  now?: () => number;
  randomId?: (prefix: string) => string;
}>;

export type KernelHostOptions = Readonly<{
  budgets?: Partial<KernelBudgets>;
  ports: KernelHostPorts;
  label?: string;
}>;

export type KernelWorkerLike = Readonly<{
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message" | "error", listener: (event: never) => void): void;
  removeEventListener(type: "message" | "error", listener: (event: never) => void): void;
}>;

type QueuedJob = {
  spec: KernelJobSpec;
  jobId: string;
  resolve: (result: KernelJobResult) => void;
  reject: (error: unknown) => void;
  listeners: ((event: KernelJobEvent) => void)[];
};

type WorkerMessageEvent = Readonly<{ data?: unknown; isTrusted?: boolean }>;

type ActiveProtocol = {
  readonly job: QueuedJob;
  readonly startedAt: number;
  nextBridgeSeq: number;
  outstandingBridgeCalls: number;
  readonly bridgeTasks: Set<Promise<void>>;
  cancelRequested?: Readonly<{ reason: string }>;
  hardCancellationReason?: string;
  deferredFinished?: Readonly<{ worker: KernelWorkerLike; result: KernelJobResult }>;
  stdoutCharge: number;
  stderrCharge: number;
  streamFrames: number;
  readonly stdout: string[];
  readonly stderr: string[];
};

const WORKER_POLICY_NAME = "airship-prime-kernel-worker";
const WORKER_ASSET_POLICY_NAME = "airship-prime-kernel-worker-asset";
let workerPolicy: TrustedTypePolicy | undefined;
let workerAssetPolicy: TrustedTypePolicy | undefined;

interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): TrustedTypePolicy;
}

interface TrustedTypePolicy {
  createScriptURL(value: string): unknown;
}

export const PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
/** Short cooperative window before cancellation enforces the worker boundary. */
export const PRIME_KERNEL_CANCEL_GRACE_MS = 100;
const PRIME_KERNEL_WORKER_RESPONSE_HEADERS = Object.freeze({
  "content-security-policy": PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
  "cross-origin-embedder-policy": "credentialless",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
});
const JAVASCRIPT_MIME_ESSENCES = new Set(["application/javascript", "text/javascript"]);

/**
 * Pyodide still uses a generated blob bootstrap. Keep its existing policy
 * blob-only while the JavaScript kernel below moves to a pinned release asset.
 */
function trustedWorkerUrl(url: string): unknown {
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
  if (!factory) return url;
  workerPolicy ??= factory.createPolicy(WORKER_POLICY_NAME, {
    createScriptURL(value) {
      if (!value.startsWith("blob:")) throw new TypeError("Kernel workers require a freshly minted blob URL.");
      return value;
    },
  });
  return workerPolicy.createScriptURL(url);
}

/**
 * Resolve the Vite import once and accept that exact same-origin URL only.
 * This covers Vite's source-worker query in development and its hashed asset
 * below any configured base path in production without admitting a lookalike
 * filename or a caller-selected same-origin script.
 */
function pinnedPrimeKernelWorkerUrl(value: string): string {
  const expected = new URL(primeKernelWorkerUrl, globalThis.location.href);
  const candidate = new URL(value, globalThis.location.href);
  if (
    candidate.href !== expected.href
    || candidate.origin !== globalThis.location.origin
    || candidate.hash !== ""
  ) {
    throw new TypeError("The Prime kernel Worker must use its pinned same-origin Vite asset.");
  }
  return candidate.href;
}

function trustedPrimeKernelWorkerUrl(value: string): unknown {
  const pinned = pinnedPrimeKernelWorkerUrl(value);
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
  if (!factory) return pinned;
  workerAssetPolicy ??= factory.createPolicy(WORKER_ASSET_POLICY_NAME, {
    createScriptURL(candidate) {
      return pinnedPrimeKernelWorkerUrl(candidate);
    },
  });
  return workerAssetPolicy.createScriptURL(pinned);
}

function primeKernelWorkerPreflightError(detail: string): never {
  throw new Error(`Prime kernel worker preflight refused the release asset: ${detail}.`);
}

/**
 * Fetching does not execute the module. It lets the host fail before the
 * Worker constructor if a static host omitted the one response policy that
 * makes string evaluation safe. The default cache mode is deliberate: an
 * active service worker must be able to rebuild a headerless network or cached
 * response, including while the app is offline.
 */
async function preflightPrimeKernelWorker(value: string, signal: AbortSignal): Promise<string> {
  if (typeof globalThis.fetch !== "function") {
    return primeKernelWorkerPreflightError("same-origin fetch is unavailable");
  }
  const exactUrl = pinnedPrimeKernelWorkerUrl(value);
  let response: Response;
  try {
    response = await globalThis.fetch(exactUrl, {
      credentials: "omit",
      mode: "same-origin",
      redirect: "manual",
      signal,
    });
  } catch {
    if (signal.aborted) throw new KernelBootSupersededError("Prime kernel worker boot was superseded.");
    return primeKernelWorkerPreflightError("the exact URL could not be fetched");
  }

  if (
    !response.ok
    || response.status !== 200
    || response.redirected
    || response.type === "opaqueredirect"
    || response.url !== exactUrl
  ) {
    return primeKernelWorkerPreflightError("the response was unsuccessful, redirected, or changed URL");
  }

  const contentType = response.headers.get("content-type");
  const mimeEssence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeEssence || !JAVASCRIPT_MIME_ESSENCES.has(mimeEssence)) {
    return primeKernelWorkerPreflightError("the response is not JavaScript");
  }
  for (const [name, expected] of Object.entries(PRIME_KERNEL_WORKER_RESPONSE_HEADERS)) {
    if (response.headers.get(name) !== expected) {
      return primeKernelWorkerPreflightError(`the ${name} header is absent, duplicated, or not exact`);
    }
  }

  // The constructor performs its own fetch. Cancel this validation body once
  // the headers are proven so preflight never retains a second worker payload.
  try {
    await response.body?.cancel();
  } catch {
    // Header authority is already established. Body cancellation is only a
    // resource optimization and must not convert a valid response into a boot failure.
  }
  return exactUrl;
}

function defaultRandomId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

const protocolEncoder = new TextEncoder();
const PROTOCOL_TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${KERNEL_PROTOCOL_TOKEN_BYTES * 2}}$`);

type DataRecord = Record<string, unknown>;

class KernelProtocolError extends Error {}
class KernelBootSupersededError extends Error {}

function protocolError(detail: string): never {
  throw new KernelProtocolError(detail);
}

/**
 * Structured-clone worker data should arrive as an ordinary own-data-property
 * record. Rebuild it from descriptors so validation never invokes a getter and
 * no TypeScript assertion stands in for a runtime check.
 */
function plainRecord(
  value: unknown,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return protocolError(`${name} must be a plain record.`);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return protocolError(`${name} could not be inspected as a plain record.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return protocolError(`${name} must have a plain-object prototype.`);
  }

  const allowed = new Set([...required, ...optional]);
  const result: DataRecord = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return protocolError(`${name} contains an unknown field.`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return protocolError(`${name}.${key} must be an enumerable data property.`);
    }
    result[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      return protocolError(`${name}.${key} is required.`);
    }
  }
  return result;
}

function requiredString(value: unknown, name: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxChars) {
    return protocolError(`${name} must be a bounded string.`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return protocolError(`${name} must be a bounded non-negative integer.`);
  }
  return value;
}

function validateJobId(value: unknown, name: string): string {
  return requiredString(value, name, MAX_KERNEL_JOB_ID_CHARS);
}

function validateProtocolToken(value: unknown, expected: string): void {
  if (typeof value !== "string" || !PROTOCOL_TOKEN_PATTERN.test(value) || value !== expected) {
    protocolError("The worker frame protocol capability is missing or invalid.");
  }
}

/** Validate the full JsonValue tree before JSON.stringify is allowed to size it. */
function assertJsonValue(value: unknown, name: string): asserts value is KernelBridgeCallRequest["arguments"] {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_KERNEL_JSON_NODES || current.depth > MAX_KERNEL_JSON_DEPTH) {
      protocolError(`${name} exceeds the JSON structure bound.`);
    }
    const entry = current.value;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) protocolError(`${name} contains a non-finite number.`);
      continue;
    }
    if (typeof entry !== "object") protocolError(`${name} is not JSON data.`);
    if (seen.has(entry)) protocolError(`${name} contains a cycle.`);
    seen.add(entry);

    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    let keys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(entry);
      descriptors = Object.getOwnPropertyDescriptors(entry);
      keys = Reflect.ownKeys(entry);
    } catch {
      protocolError(`${name} contains a non-plain value.`);
    }

    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        const key = String(index);
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          protocolError(`${name} contains a sparse or accessor array entry.`);
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length) {
          protocolError(`${name} contains a non-JSON array property.`);
        }
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      protocolError(`${name} contains a non-plain object.`);
    }
    for (const key of keys) {
      if (typeof key !== "string") protocolError(`${name} contains a symbol property.`);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        protocolError(`${name} contains an accessor or hidden property.`);
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function assertBoundedJsonValue(
  value: unknown,
  name: string,
  maximum: number,
): asserts value is KernelBridgeCallRequest["arguments"] {
  assertJsonValue(value, name);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return protocolError(`${name} could not be serialized as JSON.`);
  }
  const bytes = protocolEncoder.encode(encoded).byteLength;
  if (bytes > maximum) protocolError(`${name} exceeds its byte budget.`);
}

export class PrimeKernelHost {
  private readonly budgets: KernelBudgets;
  private readonly ports: KernelHostPorts;
  private readonly now: () => number;
  private readonly randomId: (prefix: string) => string;

  private state: KernelState = "booting";
  private worker?: KernelWorkerLike;
  private protocolToken?: string;
  private job?: QueuedJob;
  private activeProtocol?: ActiveProtocol;
  private readonly queue: QueuedJob[] = [];
  private jobTimer?: ReturnType<typeof setTimeout>;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private killPromise?: Promise<void>;
  private bootPromise?: Promise<void>;
  private bootAbort?: AbortController;
  private bootEpoch = 0;
  private generation = 0;
  private globalListeners: ((event: KernelJobEvent) => void)[] = [];

  constructor(options: KernelHostOptions) {
    const budgets = { ...DEFAULT_KERNEL_BUDGETS, ...options.budgets };
    if (!Number.isSafeInteger(budgets.maxJobWallMs) || budgets.maxJobWallMs <= 0) {
      throw new TypeError("The Prime kernel maxJobWallMs budget must be a positive safe integer.");
    }
    this.budgets = budgets;
    this.ports = options.ports;
    this.now = options.ports.now ?? (() => Date.now());
    this.randomId = options.ports.randomId ?? defaultRandomId;
  }

  description(): { state: KernelState; engine: "javascript"; generation: number; queuedJobs: number } {
    return { state: this.state, engine: "javascript", generation: this.generation, queuedJobs: this.queue.length + (this.job ? 1 : 0) };
  }

  /*
   * Uniform capability record shared with the pyodide engine so callers
   * wired through engines.ts (createKernelEngine) can read either engine
   * through one shape. describe() is additive: description() above remains
   * the pre-existing surface, and no behavior anywhere else changes.
   */
  describe(): KernelEngineDescription {
    return Object.freeze({
      state: this.state,
      engine: "javascript",
      generation: this.generation,
      queuedJobs: this.queue.length + (this.job ? 1 : 0),
      workspaceAccess: "none",
      persistence: "job",
      cancellation: "abort-signal-then-terminate-worker",
      network: "absent-ambient; tool bridge only",
    });
  }

  onEvent(listener: (event: KernelJobEvent) => void): () => void {
    this.globalListeners.push(listener);
    return () => {
      this.globalListeners = this.globalListeners.filter((entry) => entry !== listener);
    };
  }

  async start(): Promise<void> {
    if (this.killPromise) await this.killPromise;
    if (this.worker && (this.state === "ready" || this.state === "busy")) return;
    if (this.bootPromise) {
      await this.bootPromise;
      return;
    }

    const epoch = ++this.bootEpoch;
    const abort = new AbortController();
    this.bootAbort = abort;
    this.state = "booting";
    let attempt!: Promise<void>;
    attempt = this.bootWorker(epoch, abort.signal).catch((error: unknown) => {
      // terminate(), restart(), and per-job recycling invalidate the epoch
      // synchronously. A stale catch must never clear or fail the newer boot.
      if (this.bootEpoch === epoch && this.bootPromise === attempt) {
        this.bootPromise = undefined;
        if (this.bootAbort === abort) this.bootAbort = undefined;
        const worker = this.worker;
        this.worker = undefined;
        this.protocolToken = undefined;
        if (worker) {
          this.terminateWorker(worker);
          this.generation += 1;
        }
        this.state = "failed";
        this.cancelQueuedAfterBootFailure(error);
      }
      throw error;
    }).then(() => {
      if (this.bootEpoch !== epoch || this.bootPromise !== attempt || abort.signal.aborted) {
        throw new KernelBootSupersededError("Prime kernel worker boot was superseded.");
      }
      if (this.bootAbort === abort) this.bootAbort = undefined;
    });
    this.bootPromise = attempt;
    await attempt;
  }

  async exec(spec: KernelJobSpec, listener?: (event: KernelJobEvent) => void): Promise<KernelJobResult> {
    let requestedJobId: unknown;
    let code: unknown;
    let timeoutMs: unknown;
    let label: unknown;
    try {
      // Snapshot every caller-owned field exactly once before boot or any
      // other await. Queue admission must never retain a mutable caller object.
      requestedJobId = spec.jobId;
      code = spec.code;
      timeoutMs = spec.timeoutMs;
      label = spec.label;
    } catch {
      return {
        jobId: "invalid-kernel-job", engine: "javascript", outcome: "failed",
        error: "Kernel job fields could not be snapshotted.",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    const jobId = requestedJobId ?? this.randomId("kernel-job");
    if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > MAX_KERNEL_JOB_ID_CHARS) {
      return {
        jobId: typeof jobId === "string" ? jobId : "invalid-kernel-job",
        engine: "javascript", outcome: "failed",
        error: `Kernel job ids must contain 1-${MAX_KERNEL_JOB_ID_CHARS} characters.`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    if (label !== undefined && (typeof label !== "string" || label.length > MAX_KERNEL_LABEL_CHARS)) {
      return {
        jobId, engine: "javascript", outcome: "failed",
        error: `Kernel job labels may contain at most ${MAX_KERNEL_LABEL_CHARS} characters.`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    if (
      timeoutMs !== undefined
      && (
        typeof timeoutMs !== "number"
        || !Number.isSafeInteger(timeoutMs)
        || timeoutMs <= 0
        || timeoutMs > this.budgets.maxJobWallMs
      )
    ) {
      return {
        jobId, engine: "javascript", outcome: "failed",
        error: `Kernel job timeoutMs must be a positive safe integer no greater than maxJobWallMs (${this.budgets.maxJobWallMs} ms).`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    if (typeof code !== "string" || code.length > this.budgets.maxSourceChars) {
      const sourceChars = typeof code === "string" ? code.length : 0;
      return {
        jobId, engine: "javascript", outcome: "failed",
        error: `Kernel job source exceeds the source budget (${sourceChars} chars > ${this.budgets.maxSourceChars}).`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }

    const admittedSpec: KernelJobSpec = Object.freeze({ jobId, code, timeoutMs, label });

    // Admit the frozen job before asynchronous boot. cancel(jobId) must be
    // authoritative even while worker preflight or the ready handshake waits.
    if (this.job?.jobId === jobId || this.queue.some((entry) => entry.jobId === jobId)) {
      return {
        jobId, engine: "javascript", outcome: "failed",
        error: `Kernel job id ${jobId} is already active or queued.`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    const queueCapacity = this.job ? this.budgets.maxQueuedJobs : this.budgets.maxQueuedJobs + 1;
    if (this.queue.length >= queueCapacity) {
      return {
        jobId, engine: "javascript", outcome: "failed",
        error: `Kernel job queue is full (${this.budgets.maxQueuedJobs} queued jobs).`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    const admitted = new Promise<KernelJobResult>((resolve, reject) => {
      const queued: QueuedJob = { spec: admittedSpec, jobId, resolve, reject, listeners: listener ? [listener] : [] };
      this.queue.push(queued);
    });
    if (!this.worker || this.state === "booting" || this.state === "failed" || this.state === "stopped") {
      void this.start().then(
        () => this.dispatch(),
        () => undefined, // start() already cancels every admitted job on boot failure.
      );
    } else {
      this.dispatch();
    }
    return admitted;
  }

  cancel(jobId: string, reason?: string): boolean {
    const index = this.queue.findIndex((entry) => entry.jobId === jobId);
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1);
      const result: KernelJobResult = {
        jobId, engine: "javascript", outcome: "cancelled", error: reason ?? "Cancelled before execution.",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId, result }, queued.listeners);
      return true;
    }
    if (this.job && this.job.jobId === jobId) {
      const active = this.activeProtocol;
      if (!active || active.job !== this.job) return false;
      if (active.cancelRequested) return true;
      const boundedReason = typeof reason === "string" && reason
        ? reason.slice(0, Math.max(1, this.budgets.maxStreamChars))
        : "Kernel job cancelled by host policy.";
      active.cancelRequested = Object.freeze({ reason: boundedReason });
      if (this.jobTimer) {
        clearTimeout(this.jobTimer);
        this.jobTimer = undefined;
      }
      try {
        this.worker?.postMessage({ type: "cancel", jobId, reason: boundedReason });
      } catch {
        // The grace timer below is authoritative even when the advisory frame
        // cannot be delivered to a spinning or already-failed worker.
      }
      this.cancelTimer = setTimeout(() => {
        this.beginHardCancellation(active, boundedReason);
      }, PRIME_KERNEL_CANCEL_GRACE_MS);
      return true;
    }
    return false;
  }

  async terminate(reason = "Kernel terminated by host policy."): Promise<void> {
    await this.killWorker(reason);
    this.state = "stopped";
  }

  async restart(): Promise<void> {
    // killWorker is the single increment point for `generation`, because it is
    // also the crash and terminate path: counting again here made one restart
    // report two namespace resets, and a counter contractually defined as
    // "increments exactly when the namespace was reset" is worth nothing to a
    // caller if restarts count double.
    await this.killWorker("Kernel restarted by host policy.");
    this.bootPromise = undefined;
    await this.start();
  }


  private assertCurrentBoot(epoch: number, signal: AbortSignal): void {
    if (this.bootEpoch !== epoch || signal.aborted) {
      throw new KernelBootSupersededError("Prime kernel worker boot was superseded.");
    }
  }

  private async bootWorker(epoch: number, signal: AbortSignal): Promise<void> {
    this.assertCurrentBoot(epoch, signal);
    const protocolToken = createKernelProtocolToken();
    let worker: KernelWorkerLike;
    if (this.ports.workerFactory) {
      worker = this.ports.workerFactory();
    } else {
      if (typeof Worker === "undefined" || typeof globalThis.location === "undefined") {
        throw new Error("The prime kernel requires browser Workers and a same-origin release asset.");
      }
      const exactUrl = await preflightPrimeKernelWorker(primeKernelWorkerUrl, signal);
      this.assertCurrentBoot(epoch, signal);
      worker = new Worker(trustedPrimeKernelWorkerUrl(exactUrl) as string, {
        credentials: "omit",
        name: "prime-kernel",
        type: "module",
      }) as unknown as KernelWorkerLike;
    }
    try {
      this.assertCurrentBoot(epoch, signal);
    } catch (error) {
      worker.terminate();
      throw error;
    }
    this.worker = worker;
    this.protocolToken = protocolToken;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let authenticatedFrames = true;
      let announcedEngine: KernelEngine = "javascript";
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener("message", onMessage as never);
        worker.removeEventListener("error", onError as never);
        signal.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
          return;
        }
        try {
          this.assertCurrentBoot(epoch, signal);
          if (this.worker !== worker || this.protocolToken !== protocolToken) {
            throw new KernelBootSupersededError("Prime kernel worker boot was superseded.");
          }
          this.attachWorkerHandlers(worker, protocolToken, authenticatedFrames, announcedEngine);
          this.state = "ready";
          resolve();
        } catch (caught) {
          reject(caught);
        }
      };
      const onMessage = (event: WorkerMessageEvent) => {
        try {
          // Real Worker MessageEvents always define isTrusted. In-process
          // KernelWorkerLike fixtures from older callers do not. Those
          // host-authority test doubles keep structural validation, while only
          // real browser frames are admitted to the capability-bearing lane.
          authenticatedFrames = event.isTrusted !== undefined;
          const message = plainRecord(
            event.data,
            "ready frame",
            authenticatedFrames ? ["type", "engine", "protocolToken"] : ["type", "engine"],
            authenticatedFrames ? [] : ["protocolToken"],
          );
          const type = requiredString(message.type, "ready frame.type", 16);
          const engine = requiredString(message.engine, "ready frame.engine", 16);
          if (type !== "ready" || (engine !== "javascript" && engine !== "pyodide")) {
            protocolError("The first worker frame must be a valid ready frame.");
          }
          if (authenticatedFrames && engine !== "javascript") {
            protocolError("The JavaScript host requires a javascript ready frame.");
          }
          if (message.protocolToken !== undefined || authenticatedFrames) {
            validateProtocolToken(message.protocolToken, protocolToken);
          }
          announcedEngine = engine;
          settle();
        } catch (error) {
          const detail = error instanceof Error ? error.message : "invalid ready frame";
          settle(new Error(`Kernel worker protocol violation during boot: ${detail}`));
        }
      };
      const onError = (event: { message?: string }) => {
        settle(new Error(`Kernel worker failed to boot: ${String(event.message ?? "worker error")}`));
      };
      const onAbort = () => {
        settle(new KernelBootSupersededError("Prime kernel worker boot was superseded."));
      };
      worker.addEventListener("message", onMessage as never);
      worker.addEventListener("error", onError as never);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        worker.postMessage({
          type: "init",
          budgets: { ...this.budgets },
          protocolToken,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        settle(new Error(`Kernel worker failed to initialize: ${detail}`));
      }
    });
  }

  private attachWorkerHandlers(
    worker: KernelWorkerLike,
    protocolToken: string,
    authenticatedFrames: boolean,
    announcedEngine: KernelEngine,
  ): void {
    worker.addEventListener(
      "message",
      ((event: WorkerMessageEvent) => this.onWorkerMessage(
        worker,
        protocolToken,
        authenticatedFrames,
        announcedEngine,
        event,
      )) as never,
    );
    worker.addEventListener("error", (() => this.onWorkerError(worker, protocolToken)) as never);
  }

  private dispatch(): void {
    if (this.state !== "ready" || this.job) return;
    const queued = this.queue.shift();
    if (!queued) return;
    this.job = queued;
    this.activeProtocol = {
      job: queued,
      startedAt: this.now(),
      nextBridgeSeq: 0,
      outstandingBridgeCalls: 0,
      bridgeTasks: new Set<Promise<void>>(),
      stdoutCharge: 0,
      stderrCharge: 0,
      streamFrames: 0,
      stdout: [],
      stderr: [],
    };
    this.state = "busy";
    this.emit({ type: "started", jobId: queued.jobId, engine: "javascript", label: queued.spec.label });
    const timeout = queued.spec.timeoutMs ?? this.budgets.maxJobWallMs;
    this.jobTimer = setTimeout(() => {
      void this.killWorker(`Kernel job ${queued.jobId} exceeded its wall-clock budget (${timeout} ms).`);
    }, timeout);
    this.worker!.postMessage({ type: "exec", job: { jobId: queued.jobId, code: queued.spec.code, label: queued.spec.label } });
  }

  private async onWorkerMessage(
    worker: KernelWorkerLike,
    handlerToken: string,
    authenticatedFrames: boolean,
    announcedEngine: KernelEngine,
    event: WorkerMessageEvent,
  ): Promise<void> {
    if (worker !== this.worker || handlerToken !== this.protocolToken) return;
    try {
      const token = this.protocolToken;
      if (!token) protocolError("The active worker has no protocol capability.");
      const envelope = plainRecord(
        event.data,
        "worker frame",
        authenticatedFrames ? ["type", "protocolToken"] : ["type"],
        authenticatedFrames
          ? ["jobId", "text", "call", "result"]
          : ["protocolToken", "jobId", "text", "call", "result"],
      );
      if (envelope.protocolToken !== undefined || authenticatedFrames) {
        validateProtocolToken(envelope.protocolToken, token);
      }
      const type = requiredString(envelope.type, "worker frame.type", 32);

      if (type === "stdout" || type === "stderr") {
        this.onStreamFrame(event.data, type, token, authenticatedFrames);
        return;
      }
      if (type === "bridge-request") {
        const call = this.validateBridgeRequest(event.data, token, authenticatedFrames);
        const active = this.activeProtocolFor(call.jobId);
        active.outstandingBridgeCalls += 1;
        let settleAdmission!: () => void;
        const admittedTask = new Promise<void>((resolve) => { settleAdmission = resolve; });
        // Register before invoking the port. A synchronous/re-entrant
        // terminate() from port code must still see this host effect as
        // admitted and must not publish a terminal result before it settles.
        active.bridgeTasks.add(admittedTask);
        try {
          await this.onBridgeRequest(worker, call);
        } finally {
          settleAdmission();
          active.bridgeTasks.delete(admittedTask);
          if (this.activeProtocol === active && this.job === active.job) {
            active.outstandingBridgeCalls -= 1;
            if (active.outstandingBridgeCalls === 0 && active.hardCancellationReason) {
              this.finalizeHardCancellation(active, active.hardCancellationReason);
            } else if (active.outstandingBridgeCalls === 0 && active.deferredFinished) {
              const deferred = active.deferredFinished;
              active.deferredFinished = undefined;
              let terminal = deferred.result;
              // Cancellation can be accepted after the worker's finished frame
              // was deferred but before the admitted bridge effect settles.
              // Host cancellation remains authoritative across that drain.
              if (active.cancelRequested) {
                const { valueJson: _discardedValue, ...cancelled } = terminal;
                terminal = {
                  ...cancelled,
                  outcome: "cancelled",
                  error: active.cancelRequested.reason,
                };
              }
              this.finish(deferred.worker, terminal);
            }
          }
        }
        return;
      }
      if (type === "finished") {
        let result = this.validateFinishedFrame(event.data, token, authenticatedFrames, announcedEngine);
        const active = this.activeProtocolFor(result.jobId);
        if (active.cancelRequested) {
          const { valueJson: _discardedValue, ...cancelled } = result;
          result = {
            ...cancelled,
            outcome: "cancelled",
            error: active.cancelRequested.reason,
          };
        }
        if (active.deferredFinished) {
          protocolError("The worker sent more than one finished frame for the active job.");
        }
        if (active.outstandingBridgeCalls > 0) {
          // A bridge implementation can itself wait on a job queued behind
          // this one. Cancel queued work before draining so that dependency
          // cannot deadlock the terminal boundary.
          this.settleCancelledQueuedJobs(
            this.queue.splice(0),
            "The active job returned while a bridge effect was still draining.",
          );
          // End hostile code synchronously, but do not publish completion until
          // every already-admitted host effect has settled.
          active.deferredFinished = { worker, result };
          this.terminateWorker(worker);
          return;
        }
        this.finish(worker, result);
        return;
      }
      protocolError("The worker sent an unknown or out-of-phase frame type.");
    } catch (error) {
      const detail = error instanceof KernelProtocolError ? error.message : "frame validation failed.";
      this.protocolViolation(worker, detail);
    }
  }

  private activeProtocolFor(jobId: string): ActiveProtocol {
    const active = this.activeProtocol;
    if (!active || active !== this.activeProtocol || this.job !== active.job || active.job.jobId !== jobId) {
      return protocolError("The worker frame is not bound to the active job.");
    }
    return active;
  }

  private onStreamFrame(
    frame: unknown,
    type: "stdout" | "stderr",
    token: string,
    authenticated: boolean,
  ): void {
    const message = plainRecord(
      frame,
      `${type} frame`,
      authenticated ? ["type", "protocolToken", "jobId", "text"] : ["type", "jobId", "text"],
      authenticated ? [] : ["protocolToken"],
    );
    if (message.type !== type) protocolError(`${type} frame type mismatch.`);
    if (message.protocolToken !== undefined || authenticated) validateProtocolToken(message.protocolToken, token);
    const jobId = validateJobId(message.jobId, `${type} frame.jobId`);
    const active = this.activeProtocolFor(jobId);
    const text = requiredString(message.text, `${type} frame.text`, this.budgets.maxStreamChars, true);
    if (active.streamFrames >= MAX_KERNEL_STREAM_FRAMES) {
      protocolError("stream frames exceed the per-job frame-count budget.");
    }
    const frameCharge = text.length + KERNEL_STREAM_FRAME_OVERHEAD_CHARS;
    if (type === "stdout") {
      if (active.stdoutCharge + frameCharge > this.budgets.maxStreamChars) {
        protocolError("stdout frames exceed the per-job stream budget including frame boundaries.");
      }
      active.stdoutCharge += frameCharge;
      active.stdout.push(text);
    } else {
      if (active.stderrCharge + frameCharge > this.budgets.maxStreamChars) {
        protocolError("stderr frames exceed the per-job stream budget including frame boundaries.");
      }
      active.stderrCharge += frameCharge;
      active.stderr.push(text);
    }
    active.streamFrames += 1;
    this.emit({ type, jobId, text });
  }

  private validateBridgeRequest(
    frame: unknown,
    token: string,
    authenticated: boolean,
  ): KernelBridgeCallRequest {
    const message = plainRecord(
      frame,
      "bridge-request frame",
      authenticated ? ["type", "protocolToken", "jobId", "call"] : ["type", "jobId", "call"],
      authenticated ? [] : ["protocolToken"],
    );
    if (message.type !== "bridge-request") protocolError("bridge-request frame type mismatch.");
    if (message.protocolToken !== undefined || authenticated) validateProtocolToken(message.protocolToken, token);
    const jobId = validateJobId(message.jobId, "bridge-request frame.jobId");
    const active = this.activeProtocolFor(jobId);
    const record = plainRecord(message.call, "bridge-request frame.call", ["jobId", "seq", "tool", "arguments"]);
    const innerJobId = validateJobId(record.jobId, "bridge-request frame.call.jobId");
    if (innerJobId !== jobId) protocolError("The bridge request carries conflicting job ids.");
    const seq = requiredSafeInteger(record.seq, "bridge-request frame.call.seq");
    if (seq !== active.nextBridgeSeq) {
      protocolError("The bridge sequence is duplicate or out of order.");
    }
    if (active.nextBridgeSeq >= this.budgets.maxBridgeCallsPerJob) {
      protocolError("The worker exceeded maxBridgeCallsPerJob.");
    }
    const tool = requiredString(record.tool, "bridge-request frame.call.tool", MAX_KERNEL_TOOL_NAME_CHARS);
    assertBoundedJsonValue(record.arguments, "bridge-request frame.call.arguments", this.budgets.maxBridgePayloadBytes);
    active.nextBridgeSeq += 1;
    return { jobId, seq, tool, arguments: record.arguments };
  }

  private async onBridgeRequest(worker: KernelWorkerLike, call: KernelBridgeCallRequest): Promise<void> {
    const active = this.activeProtocolFor(call.jobId);
    this.emit({ type: "bridge-call", jobId: call.jobId, seq: call.seq, tool: call.tool, arguments: call.arguments });
    let result: KernelBridgeCallResult;
    try {
      const raw: unknown = await this.ports.bridge.call(call, active.job.spec.label);
      result = this.validateBridgeResult(raw, call.seq);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const bounded = detail.slice(0, Math.max(1, this.budgets.maxBridgePayloadBytes));
      result = { seq: call.seq, ok: false, error: bounded || "The tool call failed." };
    }

    // A job can finish or the generation can be killed while its host tool is
    // still pending. Never deliver that stale response into a later cell.
    if (worker !== this.worker || this.activeProtocol !== active || this.job !== active.job) return;
    this.emit({ type: "bridge-result", jobId: call.jobId, seq: call.seq, ok: result.ok });
    worker.postMessage({ type: "bridge-response", jobId: call.jobId, call: result });
  }

  private validateBridgeResult(value: unknown, expectedSeq: number): KernelBridgeCallResult {
    const record = plainRecord(value, "bridge result", ["seq", "ok"], ["content", "error", "metadata"]);
    const seq = requiredSafeInteger(record.seq, "bridge result.seq");
    if (seq !== expectedSeq) protocolError("The bridge result sequence does not match its request.");
    if (record.ok !== true && record.ok !== false) protocolError("bridge result.ok must be boolean.");

    const metadata = record.metadata;
    if (metadata !== undefined) {
      assertBoundedJsonValue(metadata, "bridge result.metadata", this.budgets.maxBridgePayloadBytes);
    }
    if (record.ok === true) {
      const content = requiredString(record.content, "bridge result.content", this.budgets.maxBridgePayloadBytes, true);
      const sanitized = metadata === undefined
        ? { seq, ok: true as const, content }
        : { seq, ok: true as const, content, metadata };
      assertBoundedJsonValue(sanitized, "bridge result", this.budgets.maxBridgePayloadBytes);
      return sanitized;
    }
    const error = requiredString(record.error, "bridge result.error", this.budgets.maxBridgePayloadBytes);
    const sanitized = metadata === undefined
      ? { seq, ok: false as const, error }
      : { seq, ok: false as const, error, metadata };
    assertBoundedJsonValue(sanitized, "bridge result", this.budgets.maxBridgePayloadBytes);
    return sanitized;
  }

  private validateFinishedFrame(
    frame: unknown,
    token: string,
    authenticated: boolean,
    announcedEngine: KernelEngine,
  ): KernelJobResult {
    const message = plainRecord(
      frame,
      "finished frame",
      authenticated ? ["type", "protocolToken", "jobId", "result"] : ["type", "jobId", "result"],
      authenticated ? [] : ["protocolToken"],
    );
    if (message.type !== "finished") protocolError("finished frame type mismatch.");
    if (message.protocolToken !== undefined || authenticated) validateProtocolToken(message.protocolToken, token);
    const jobId = validateJobId(message.jobId, "finished frame.jobId");
    const active = this.activeProtocolFor(jobId);
    const record = plainRecord(
      message.result,
      "finished frame.result",
      ["jobId", "engine", "outcome", "stdout", "stderr", "bridgeCalls", "wallMs"],
      ["valueJson", "error"],
    );
    if (validateJobId(record.jobId, "finished frame.result.jobId") !== jobId) {
      protocolError("The finished frame carries conflicting job ids.");
    }
    if (record.engine !== announcedEngine) protocolError("The finished result engine is invalid.");
    if (record.outcome !== "completed" && record.outcome !== "failed" && record.outcome !== "cancelled") {
      protocolError("The finished result outcome is invalid.");
    }
    const stdout = requiredString(record.stdout, "finished frame.result.stdout", this.budgets.maxStreamChars, true);
    const stderr = requiredString(record.stderr, "finished frame.result.stderr", this.budgets.maxStreamChars, true);
    if (authenticated && (stdout !== active.stdout.join("\n") || stderr !== active.stderr.join("\n"))) {
      protocolError("The finished streams do not match the authenticated stream frames.");
    }
    const bridgeCalls = requiredSafeInteger(
      record.bridgeCalls,
      "finished frame.result.bridgeCalls",
      this.budgets.maxBridgeCallsPerJob,
    );
    if (bridgeCalls !== active.nextBridgeSeq) {
      protocolError("The finished bridge-call count does not match the accepted sequence.");
    }
    const wallMs = requiredSafeInteger(record.wallMs, "finished frame.result.wallMs");

    if (record.outcome === "completed") {
      if (record.error !== undefined) protocolError("A completed result cannot carry an error.");
      if (record.valueJson === undefined) {
        return { jobId, engine: announcedEngine, outcome: "completed", stdout, stderr, bridgeCalls, wallMs };
      }
      const valueJson = requiredString(record.valueJson, "finished frame.result.valueJson", this.budgets.maxValueBytes, true);
      if (protocolEncoder.encode(valueJson).byteLength > this.budgets.maxValueBytes) {
        protocolError("The finished value exceeds maxValueBytes.");
      }
      if (authenticated) {
        try {
          JSON.parse(valueJson);
        } catch {
          protocolError("The finished valueJson is not valid JSON.");
        }
      }
      return { jobId, engine: announcedEngine, outcome: "completed", valueJson, stdout, stderr, bridgeCalls, wallMs };
    }

    if (record.valueJson !== undefined) protocolError("A failed or cancelled result cannot carry valueJson.");
    const error = requiredString(record.error, "finished frame.result.error", this.budgets.maxStreamChars);
    return { jobId, engine: announcedEngine, outcome: record.outcome, error, stdout, stderr, bridgeCalls, wallMs };
  }

  private protocolViolation(worker: KernelWorkerLike, detail: string): void {
    if (worker !== this.worker) return;
    void this.killWorker(`Kernel worker protocol violation: ${detail}`);
  }

  private invalidateBoot(): void {
    this.bootEpoch += 1;
    const abort = this.bootAbort;
    this.bootAbort = undefined;
    this.bootPromise = undefined;
    abort?.abort();
  }

  private terminateWorker(worker: KernelWorkerLike | undefined): void {
    if (!worker) return;
    try {
      worker.postMessage({ type: "terminate" });
    } catch {
      // Worker.terminate is the browser-enforced boundary; the advisory frame
      // is allowed to fail when the worker has already crashed.
    }
    worker.terminate();
  }

  private beginHardCancellation(active: ActiveProtocol, reason: string): void {
    if (this.activeProtocol !== active || this.job !== active.job) return;
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
    }
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    const queuedJobs = this.queue.splice(0);
    this.settleCancelledQueuedJobs(
      queuedJobs,
      "Kernel active-job cancellation reset this queued job before it could execute.",
    );
    active.hardCancellationReason = reason;
    // Stop hostile code synchronously. Host-side bridge effects that were
    // already admitted remain tracked, and completion is withheld until they
    // settle so no reviewed mutation occurs after the cancelled result.
    this.terminateWorker(this.worker);
    if (active.outstandingBridgeCalls === 0) {
      this.finalizeHardCancellation(active, reason);
    }
  }

  private finalizeHardCancellation(active: ActiveProtocol, reason: string): void {
    if (this.activeProtocol !== active || this.job !== active.job) return;
    const worker = this.worker;
    const job = this.job;
    this.state = "draining";
    this.worker = undefined;
    this.protocolToken = undefined;
    this.job = undefined;
    this.activeProtocol = undefined;
    this.invalidateBoot();
    if (worker) this.generation += 1;
    const result: KernelJobResult = {
      jobId: job.jobId,
      engine: "javascript",
      outcome: "cancelled",
      error: `${reason} The worker was hard-terminated after the ${PRIME_KERNEL_CANCEL_GRACE_MS} ms cancellation grace.`,
      stdout: active.stdout.join("\n"),
      stderr: active.stderr.join("\n"),
      bridgeCalls: active.nextBridgeSeq,
      wallMs: Math.max(0, this.now() - active.startedAt),
    };
    job.resolve(result);
    this.emit({ type: "cancelled", jobId: job.jobId, result }, job.listeners);
    this.state = "ready";
    if (this.queue.length > 0) {
      void this.start().then(() => this.dispatch()).catch(() => {
        // start() names the failure and settles every queued job.
      });
    }
  }

  private finish(worker: KernelWorkerLike, result: KernelJobResult): void {
    if (worker !== this.worker) return;
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
    }
    const job = this.job;
    this.state = "draining";
    this.job = undefined;
    this.activeProtocol = undefined;
    this.worker = undefined;
    this.protocolToken = undefined;
    this.invalidateBoot();

    // This synchronous termination is the hard post-completion boundary. A
    // Promise microtask loop scheduled by job code can run only until its
    // authenticated finished frame is accepted; it cannot consume a core or
    // receive the next exec frame after the result resolves.
    this.terminateWorker(worker);
    this.generation += 1;
    this.state = "ready";

    if (job) {
      job.resolve(result);
      this.emit({ type: result.outcome === "completed" ? "completed" : result.outcome, jobId: result.jobId, result }, job.listeners);
    }
    if (this.queue.length > 0) {
      void this.start().then(() => this.dispatch()).catch(() => {
        // start() names the failure and settles every queued job. Do not turn
        // that already-reported boundary into an unhandled promise rejection.
      });
    }
  }

  private cancelQueuedAfterBootFailure(error: unknown): void {
    const detail = (error instanceof Error ? error.message : String(error))
      .slice(0, Math.max(1, this.budgets.maxStreamChars));
    for (const queued of this.queue.splice(0)) {
      const result: KernelJobResult = {
        jobId: queued.jobId,
        engine: "javascript",
        outcome: "cancelled",
        error: `Kernel worker failed to boot before this queued job: ${detail || "unknown boot failure"}`,
        stdout: "",
        stderr: "",
        bridgeCalls: 0,
        wallMs: 0,
      };
      const failure = error instanceof Error
        ? error
        : new Error(`Kernel worker failed to boot: ${detail || "unknown boot failure"}`);
      queued.reject(failure);
      this.emit({ type: "cancelled", jobId: queued.jobId, result }, queued.listeners);
    }
  }

  private settleCancelledQueuedJobs(jobs: readonly QueuedJob[], error: string): void {
    for (const queued of jobs) {
      const result: KernelJobResult = {
        jobId: queued.jobId,
        engine: "javascript",
        outcome: "cancelled",
        error,
        stdout: "",
        stderr: "",
        bridgeCalls: 0,
        wallMs: 0,
      };
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId: queued.jobId, result }, queued.listeners);
    }
  }

  private killWorker(reason: string): Promise<void> {
    if (this.killPromise) return this.killPromise;
    let attempt!: Promise<void>;
    attempt = this.performKillWorker(reason).finally(() => {
      if (this.killPromise === attempt) this.killPromise = undefined;
    });
    this.killPromise = attempt;
    return attempt;
  }

  private async performKillWorker(reason: string): Promise<void> {
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
    }
    const worker = this.worker;
    const protocol = this.activeProtocol;
    const job = this.job;
    const queuedJobs = this.queue.splice(0);
    const admittedBridgeTasks = protocol ? [...protocol.bridgeTasks] : [];
    this.state = "draining";
    this.worker = undefined;
    this.protocolToken = undefined;
    this.activeProtocol = undefined;
    this.job = undefined;
    this.invalidateBoot();
    this.terminateWorker(worker);
    if (worker) this.generation += 1;
    this.settleCancelledQueuedJobs(
      queuedJobs,
      "Kernel worker was reset while this job was queued; the namespace was reset.",
    );

    // Protocol faults, watchdog expiry, administrative termination, and real
    // worker crashes all stop guest code immediately. Their terminal result is
    // still withheld until every host effect admitted before that boundary has
    // settled, so no reviewed mutation can occur after a published crash.
    if (admittedBridgeTasks.length > 0) {
      await Promise.allSettled(admittedBridgeTasks);
    }

    if (job) {
      const result: KernelJobResult = {
        jobId: job.jobId,
        engine: "javascript",
        outcome: "crashed",
        error: reason,
        stdout: protocol?.job === job ? protocol.stdout.join("\n") : "",
        stderr: protocol?.job === job ? protocol.stderr.join("\n") : "",
        bridgeCalls: protocol?.job === job ? protocol.nextBridgeSeq : 0,
        wallMs: protocol?.job === job ? Math.max(0, this.now() - protocol.startedAt) : 0,
      };
      job.resolve(result);
      this.emit({ type: "crashed", jobId: job.jobId, result }, job.listeners);
    }

    this.state = "failed";
  }


  private onWorkerError(worker: KernelWorkerLike, handlerToken: string): void {
    if (worker !== this.worker || handlerToken !== this.protocolToken) return;
    void this.killWorker("Kernel worker crashed; the namespace was reset.");
  }

  private emit(event: KernelJobEvent, jobListeners?: ((event: KernelJobEvent) => void)[]): void {
    for (const listener of this.globalListeners) listener(event);
    const target = jobListeners ?? this.job?.listeners;
    if (target) for (const listener of target) listener(event);
  }
}

/**
 * The legacy blob-only Trusted Types policy exported for the Pyodide engine.
 * The JavaScript kernel uses the separate exact-asset policy above.
 */
export const kernelTrustedWorkerUrl: (url: string) => unknown = trustedWorkerUrl;
