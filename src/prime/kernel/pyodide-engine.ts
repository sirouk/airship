/**
 * Persistent Pyodide kernel host.
 *
 * Each worker generation owns one CPython namespace. The host admits one
 * frozen job snapshot at a time, authenticates every worker frame with an
 * exact generation-local capability, validates all bridge/result data, and
 * keeps cooperative cancellation followed by worker termination as the hard
 * reset boundary.
 *
 * This direct class is a research seam, not an activation-safe factory lane.
 * CPython can retain an asyncio task across cells, and the shared `pat` module
 * cannot prove which cell invoked it. createKernelEngine("pyodide") must stay
 * quarantined until task provenance is enforceable without destroying the
 * persistent namespace.
 */

import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelBudgets,
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
import type { KernelHostPorts, KernelWorkerLike } from "./kernel-host";
import { kernelTrustedWorkerUrl } from "./kernel-host";
import { createKernelProtocolToken } from "./kernel-worker-source";
import {
  PYODIDE_CANCELLED_AT_BOUNDARY,
  PYODIDE_KERNEL_PROTOCOL_VERSION,
  pyodideKernelWorkerSource,
} from "./pyodide-worker-source";

export const PYODIDE_VERSION = "314.0.2";
/** Resolve the emitted pack below Airship's validated absolute Vite base. */
export function pyodideAssetPathForBase(baseUrl: string): string {
  const segments = baseUrl.split("/");
  if (
    !baseUrl.startsWith("/")
    || baseUrl.startsWith("//")
    || !baseUrl.endsWith("/")
    || baseUrl.includes("?")
    || baseUrl.includes("#")
    || baseUrl.includes("\\")
    || segments.includes(".")
    || segments.includes("..")
  ) {
    throw new TypeError("The Pyodide asset base must be a pinned absolute URL path ending in '/'.");
  }
  return `${baseUrl}execution-packs/pyodide/`;
}
/** Base-aware URL of the pinned pack emitted by the Vite asset plugin. */
export const PYODIDE_ASSET_PATH = pyodideAssetPathForBase(import.meta.env.BASE_URL);
export const PYODIDE_TERMINATE_GRACE_MS = 500;
const PYODIDE_WORKER_NAME = "prime-kernel-pyodide";
const PYODIDE_DRAINING_ADMISSION_ERROR =
  "The Pyodide kernel is draining an admitted host bridge effect; recursive jobs cannot be admitted.";
const PYODIDE_DEPENDENCY_CYCLE_CANCELLATION =
  "The active Pyodide job reached a terminal boundary while a host bridge effect was still draining; queued work was cancelled to break a same-engine dependency cycle.";

export type PyodideKernelHostPorts = KernelHostPorts & Readonly<{
  /** Test/qualified-host hint; browser construction accepts only the exact pinned BASE_URL asset. */
  assetBase?: string;
}>;

export type PyodideKernelEngineOptions = Readonly<{
  budgets?: Partial<KernelBudgets>;
  ports: PyodideKernelHostPorts;
  label?: string;
}>;

type QueuedJob = {
  spec: KernelJobSpec;
  jobId: string;
  resolve: (result: KernelJobResult) => void;
  listeners: ((event: KernelJobEvent) => void)[];
};

type WorkerMessageEvent = Readonly<{ data?: unknown; isTrusted?: boolean }>;
type DataRecord = Record<string, unknown>;

type ActiveProtocol = {
  readonly job: QueuedJob;
  readonly startedAt: number;
  nextBridgeSeq: number;
  outstandingBridgeCalls: number;
  cancelRequested?: string;
  readonly bridgeTasks: Set<Promise<void>>;
  deferredFinished?: Readonly<{ worker: KernelWorkerLike; result: KernelJobResult }>;
  stdoutCharge: number;
  stderrCharge: number;
  streamFrames: number;
  readonly stdout: string[];
  readonly stderr: string[];
};

class PyodideProtocolError extends Error {}
class PyodideBootSupersededError extends Error {}

const protocolEncoder = new TextEncoder();
const PROTOCOL_TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${KERNEL_PROTOCOL_TOKEN_BYTES * 2}}$`);

function protocolError(detail: string): never {
  throw new PyodideProtocolError(detail);
}

/** Read structured-clone data without invoking accessors. */
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
  const result: DataRecord = Object.create(null) as DataRecord;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return protocolError(`${name} contains an unknown field.`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return protocolError(`${name}.${key} must be an enumerable data property.`);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
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

function validateWorkerEvent(event: WorkerMessageEvent): void {
  // Native MessageEvent always exposes isTrusted. Test adapters may omit it,
  // but a present false bit is never authority.
  if (event.isTrusted !== undefined && event.isTrusted !== true) {
    protocolError("The worker frame was not delivered by the browser controller.");
  }
}

function validateEnvelope(record: DataRecord, token: string, generation: number): void {
  if (
    record.protocol !== PYODIDE_KERNEL_PROTOCOL_VERSION
    || typeof record.protocolToken !== "string"
    || !PROTOCOL_TOKEN_PATTERN.test(record.protocolToken)
    || record.protocolToken !== token
    || record.generation !== generation
  ) {
    protocolError("The worker frame generation capability is missing or invalid.");
  }
}

function protocolFrame(
  frame: Record<string, unknown>,
  token: string,
  generation: number,
): Record<string, unknown> {
  return {
    ...frame,
    protocol: PYODIDE_KERNEL_PROTOCOL_VERSION,
    protocolToken: token,
    generation,
  };
}

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
        const descriptor = descriptors[String(index)];
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
  if (protocolEncoder.encode(encoded).byteLength > maximum) {
    protocolError(`${name} exceeds its byte budget.`);
  }
}

function defaultRandomId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function defaultAssetBase(): string {
  const location = (globalThis as { location?: { href?: string } }).location;
  if (!location || typeof location.href !== "string") {
    throw new Error("The browser Pyodide kernel needs globalThis.location to pin its pack URL.");
  }
  return new URL(PYODIDE_ASSET_PATH, location.href).href;
}

function pinnedBrowserAssetBase(override: string | undefined): string {
  const expected = defaultAssetBase();
  if (override === undefined) return expected;
  const candidateText = override.endsWith("/") ? override : `${override}/`;
  const candidate = new URL(candidateText, expected);
  if (candidate.href !== expected || candidate.hash || candidate.search) {
    throw new TypeError(
      `The Pyodide kernel pack is pinned to ${expected}; ports.assetBase cannot select another browser asset.`,
    );
  }
  return expected;
}

function failedAdmission(jobId: string, error: string): KernelJobResult {
  return Object.freeze({
    jobId,
    engine: "pyodide" as const,
    outcome: "failed" as const,
    error,
    stdout: "",
    stderr: "",
    bridgeCalls: 0,
    wallMs: 0,
  });
}

export class PyodideKernelEngine {
  private readonly budgets: KernelBudgets;
  private readonly ports: PyodideKernelHostPorts;
  private readonly now: () => number;
  private readonly randomId: (prefix: string) => string;

  private state: KernelState = "booting";
  private worker?: KernelWorkerLike;
  private protocolToken?: string;
  private protocolGeneration?: number;
  private job?: QueuedJob;
  private activeProtocol?: ActiveProtocol;
  private readonly queue: QueuedJob[] = [];
  private jobTimer?: ReturnType<typeof setTimeout>;
  private cancelGraceTimer?: ReturnType<typeof setTimeout>;
  private bootPromise?: Promise<void>;
  private killPromise?: Promise<void>;
  private bootAbort?: AbortController;
  private bootEpoch = 0;
  private generation = 0;
  private globalListeners: ((event: KernelJobEvent) => void)[] = [];
  private generationBootMs?: number;
  private pendingBootStamp = false;
  private runtimeVersion?: string;

  constructor(options: PyodideKernelEngineOptions) {
    const budgets = { ...DEFAULT_KERNEL_BUDGETS, ...options.budgets };
    for (const [name, amount] of Object.entries(budgets)) {
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new TypeError(`The Pyodide kernel ${name} budget must be a positive safe integer.`);
      }
    }
    this.budgets = Object.freeze(budgets);
    this.ports = options.ports;
    this.now = options.ports.now ?? (() => Date.now());
    this.randomId = options.ports.randomId ?? defaultRandomId;
  }

  description(): { state: KernelState; engine: "pyodide"; generation: number; queuedJobs: number } {
    return {
      state: this.state,
      engine: "pyodide",
      generation: this.generation,
      queuedJobs: this.queue.length + (this.job ? 1 : 0),
    };
  }

  describe(): KernelEngineDescription {
    return Object.freeze({
      state: this.state,
      engine: "pyodide",
      generation: this.generation,
      queuedJobs: this.queue.length + (this.job ? 1 : 0),
      bootMs: this.generationBootMs,
      version: PYODIDE_VERSION,
      runtimeVersion: this.runtimeVersion,
      workspaceAccess: "none",
      persistence: "kernel-instance",
      cancellation: "cooperative-then-terminate-worker",
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
      if (this.bootEpoch === epoch && this.bootPromise === attempt) {
        this.bootPromise = undefined;
        if (this.bootAbort === abort) this.bootAbort = undefined;
        const worker = this.worker;
        const token = this.protocolToken;
        const generation = this.protocolGeneration;
        this.worker = undefined;
        this.protocolToken = undefined;
        this.protocolGeneration = undefined;
        if (worker) {
          this.terminateWorker(worker, token, generation);
          this.generation += 1;
        }
        this.runtimeVersion = undefined;
        this.generationBootMs = undefined;
        this.pendingBootStamp = false;
        this.state = "failed";
        this.cancelQueuedAfterBootFailure(error);
      }
      throw error;
    }).then(() => {
      if (this.bootEpoch !== epoch || this.bootPromise !== attempt || abort.signal.aborted) {
        throw new PyodideBootSupersededError("Pyodide kernel worker boot was superseded.");
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
      // An async function runs synchronously until its first await. Read every
      // caller field exactly once now; no mutable caller object crosses boot.
      requestedJobId = spec.jobId;
      code = spec.code;
      timeoutMs = spec.timeoutMs;
      label = spec.label;
    } catch {
      return failedAdmission("invalid-kernel-job", "Kernel job fields could not be snapshotted.");
    }

    const jobId = requestedJobId ?? this.randomId("kernel-job");
    if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > MAX_KERNEL_JOB_ID_CHARS) {
      return failedAdmission(
        typeof jobId === "string" ? jobId : "invalid-kernel-job",
        `Kernel job ids must contain 1-${MAX_KERNEL_JOB_ID_CHARS} characters.`,
      );
    }
    if (label !== undefined && (typeof label !== "string" || label.length > MAX_KERNEL_LABEL_CHARS)) {
      return failedAdmission(jobId, `Kernel job labels may contain at most ${MAX_KERNEL_LABEL_CHARS} characters.`);
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
      return failedAdmission(
        jobId,
        `Kernel job timeoutMs must be a positive safe integer no greater than maxJobWallMs (${this.budgets.maxJobWallMs} ms).`,
      );
    }
    if (typeof code !== "string" || code.length > this.budgets.maxSourceChars) {
      const sourceChars = typeof code === "string" ? code.length : 0;
      return failedAdmission(
        jobId,
        `Kernel job source exceeds the source budget (${sourceChars} chars > ${this.budgets.maxSourceChars}).`,
      );
    }

    const admittedSpec: KernelJobSpec = Object.freeze({ jobId, code, timeoutMs, label });
    if (this.state === "draining" || this.killPromise) {
      return failedAdmission(jobId, PYODIDE_DRAINING_ADMISSION_ERROR);
    }
    if (this.job?.jobId === jobId || this.queue.some((entry) => entry.jobId === jobId)) {
      return failedAdmission(jobId, `Kernel job id ${jobId} is already active or queued.`);
    }
    if (this.queue.length >= this.budgets.maxQueuedJobs) {
      return failedAdmission(jobId, `Kernel job queue is full (${this.budgets.maxQueuedJobs} queued jobs).`);
    }

    const result = new Promise<KernelJobResult>((resolve) => {
      const queued: QueuedJob = {
        spec: admittedSpec,
        jobId,
        resolve,
        listeners: listener ? [listener] : [],
      };
      // Admission is synchronous and precedes boot. cancel(jobId) can revoke a
      // job while the pinned interpreter is still loading, and boot failure
      // can settle every already-admitted queue entry rather than losing it in
      // an exec() continuation.
      this.queue.push(queued);
    });
    if (this.worker && this.state === "ready") {
      this.dispatch();
    } else {
      void this.start().then(() => this.dispatch()).catch(() => {
        // start() names the boot failure and settles all admitted queue entries.
      });
    }
    return result;
  }

  cancel(jobId: string, reason?: string): boolean {
    const boundedReason = typeof reason === "string"
      ? reason.slice(0, Math.max(1, this.budgets.maxStreamChars))
      : undefined;
    const index = this.queue.findIndex((entry) => entry.jobId === jobId);
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1);
      const result = this.stampBoot(Object.freeze({
        jobId,
        engine: "pyodide" as const,
        outcome: "cancelled" as const,
        error: boundedReason ?? "Cancelled before execution.",
        stdout: "",
        stderr: "",
        bridgeCalls: 0,
        wallMs: 0,
      }));
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId, result }, queued.listeners);
      return true;
    }
    if (this.job && this.job.jobId === jobId) {
      const reasonText = boundedReason && boundedReason.length > 0
        ? boundedReason
        : "kernel job cancelled";
      if (this.activeProtocol?.job === this.job) {
        this.activeProtocol.cancelRequested ??= reasonText;
      }
      this.postController({ type: "cancel", jobId, reason: reasonText });
      this.armCancelGrace(jobId, reasonText);
      return true;
    }
    return false;
  }

  async terminate(reason = "Kernel terminated by host policy."): Promise<void> {
    await this.killWorker(reason);
    this.state = "stopped";
  }

  async restart(): Promise<void> {
    await this.killWorker("Kernel restarted by host policy; the Python namespace was reset.");
    await this.start();
  }

  private assertCurrentBoot(epoch: number, signal: AbortSignal): void {
    if (this.bootEpoch !== epoch || signal.aborted) {
      throw new PyodideBootSupersededError("Pyodide kernel worker boot was superseded.");
    }
  }

  private async bootWorker(epoch: number, signal: AbortSignal): Promise<void> {
    this.assertCurrentBoot(epoch, signal);
    const token = createKernelProtocolToken();
    const generation = this.generation;
    let worker: KernelWorkerLike;
    if (this.ports.workerFactory) {
      worker = this.ports.workerFactory();
    } else {
      if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("The pyodide kernel requires browser Workers and URL.createObjectURL.");
      }
      const assetBase = pinnedBrowserAssetBase(this.ports.assetBase);
      const source = pyodideKernelWorkerSource(this.budgets, assetBase);
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try {
        worker = new Worker(kernelTrustedWorkerUrl(url) as string, {
          name: PYODIDE_WORKER_NAME,
          type: "module",
        }) as unknown as KernelWorkerLike;
      } finally {
        // Worker construction snapshots the module URL. Restarts must not leak
        // one retained blob URL per persistent namespace generation.
        URL.revokeObjectURL(url);
      }
    }
    try {
      this.assertCurrentBoot(epoch, signal);
    } catch (error) {
      worker.terminate();
      throw error;
    }
    this.worker = worker;
    this.protocolToken = token;
    this.protocolGeneration = generation;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
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
          if (
            this.worker !== worker
            || this.protocolToken !== token
            || this.protocolGeneration !== generation
          ) {
            throw new PyodideBootSupersededError("Pyodide kernel worker boot was superseded.");
          }
          this.attachWorkerHandlers(worker, token, generation);
          this.state = "ready";
          resolve();
        } catch (caught) {
          reject(caught instanceof Error ? caught : new Error(String(caught)));
        }
      };
      const onMessage = (event: WorkerMessageEvent) => {
        try {
          validateWorkerEvent(event);
          const head = plainRecord(
            event.data,
            "Pyodide boot frame",
            ["type", "engine", "protocol", "protocolToken", "generation"],
            ["bootMs", "version", "error"],
          );
          validateEnvelope(head, token, generation);
          if (head.engine !== "pyodide") protocolError("The Pyodide boot frame has the wrong engine.");
          if (head.type === "boot-failed") {
            const error = requiredString(head.error, "boot-failed frame.error", this.budgets.maxStreamChars);
            settle(new Error(`Pyodide kernel failed to boot: ${error}`));
            return;
          }
          if (head.type !== "ready") protocolError("The first Pyodide worker frame must be ready or boot-failed.");
          const reportedVersion = requiredString(head.version, "ready frame.version", 64);
          if (reportedVersion !== PYODIDE_VERSION) {
            settle(new Error(
              `Pyodide kernel asset/pin mismatch: the worker reports pyodide@${reportedVersion} but the engine is pinned to pyodide@${PYODIDE_VERSION}. `
              + `Refresh ${PYODIDE_ASSET_PATH} to the pinned pack before starting kernel jobs.`,
            ));
            return;
          }
          const bootMs = requiredSafeInteger(head.bootMs, "ready frame.bootMs");
          this.runtimeVersion = reportedVersion;
          this.generationBootMs = bootMs;
          this.pendingBootStamp = true;
          settle();
        } catch (error) {
          const detail = error instanceof Error ? error.message : "invalid boot frame";
          settle(new Error(`Pyodide kernel worker protocol violation during boot: ${detail}`));
        }
      };
      const onError = (event: { message?: string }) => {
        settle(new Error(`Pyodide kernel worker failed to boot: ${String(event.message ?? "worker error")}`));
      };
      const onAbort = () => settle(new PyodideBootSupersededError("Pyodide kernel worker boot was superseded."));
      worker.addEventListener("message", onMessage as never);
      worker.addEventListener("error", onError as never);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        worker.postMessage(protocolFrame({ type: "init" }, token, generation));
      } catch (error) {
        settle(new Error(`Pyodide kernel worker failed to initialize: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private attachWorkerHandlers(worker: KernelWorkerLike, token: string, generation: number): void {
    worker.addEventListener(
      "message",
      ((event: WorkerMessageEvent) => this.onWorkerMessage(worker, token, generation, event)) as never,
    );
    worker.addEventListener(
      "error",
      (() => this.onWorkerError(worker, token, generation)) as never,
    );
  }

  private postController(frame: Record<string, unknown>): void {
    const worker = this.worker;
    const token = this.protocolToken;
    const generation = this.protocolGeneration;
    if (!worker || !token || generation === undefined) return;
    worker.postMessage(protocolFrame(frame, token, generation));
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
      bridgeTasks: new Set(),
      stdoutCharge: 0,
      stderrCharge: 0,
      streamFrames: 0,
      stdout: [],
      stderr: [],
    };
    this.state = "busy";
    const worker = this.worker;
    this.emit({ type: "started", jobId: queued.jobId, engine: "pyodide", label: queued.spec.label });
    // The same re-entrancy fence the JavaScript host carries: a subscriber that
    // cancels or terminates during this announcement leaves the job settled,
    // and a wall clock armed afterwards belongs to nothing.
    if (!worker || this.worker !== worker || this.job !== queued || this.activeProtocol?.job !== queued) return;
    const timeout = queued.spec.timeoutMs ?? this.budgets.maxJobWallMs;
    this.jobTimer = setTimeout(() => {
      const reason = `Kernel job ${queued.jobId} exceeded its wall-clock budget (${timeout} ms).`;
      if (this.activeProtocol?.job === queued) this.activeProtocol.cancelRequested ??= reason;
      this.postController({ type: "cancel", jobId: queued.jobId, reason });
      this.armCancelGrace(queued.jobId, reason);
    }, timeout);
    try {
      this.postController({
        type: "exec",
        job: { jobId: queued.jobId, code: queued.spec.code, label: queued.spec.label },
      });
    } catch {
      void this.killWorker("Pyodide kernel worker rejected the exec frame; the Python namespace was reset.");
    }
  }

  private armCancelGrace(jobId: string, reason: string): void {
    if (this.cancelGraceTimer) clearTimeout(this.cancelGraceTimer);
    this.cancelGraceTimer = setTimeout(() => {
      this.cancelGraceTimer = undefined;
      void this.killWorker(
        `Kernel job ${jobId} did not settle within ${PYODIDE_TERMINATE_GRACE_MS} ms of cooperative cancellation (${reason}); `
        + "the worker was terminated and the Python namespace was reset, which is the hard cancellation boundary reported in describe().",
      );
    }, PYODIDE_TERMINATE_GRACE_MS);
  }

  private async onWorkerMessage(
    worker: KernelWorkerLike,
    handlerToken: string,
    handlerGeneration: number,
    event: WorkerMessageEvent,
  ): Promise<void> {
    if (
      worker !== this.worker
      || handlerToken !== this.protocolToken
      || handlerGeneration !== this.protocolGeneration
    ) return;
    try {
      validateWorkerEvent(event);
      const envelope = plainRecord(
        event.data,
        "Pyodide worker frame",
        ["type", "protocol", "protocolToken", "generation"],
        ["jobId", "text", "call", "result", "engine", "error", "bootMs", "version"],
      );
      validateEnvelope(envelope, handlerToken, handlerGeneration);
      const type = requiredString(envelope.type, "worker frame.type", 32);
      if (type === "stdout" || type === "stderr") {
        this.onStreamFrame(event.data, type, handlerToken, handlerGeneration);
        return;
      }
      if (type === "bridge-request") {
        const call = this.validateBridgeRequest(event.data, handlerToken, handlerGeneration);
        const active = this.activeProtocolFor(call.jobId);
        active.outstandingBridgeCalls += 1;
        let settleAdmission!: () => void;
        const admittedTask = new Promise<void>((resolve) => { settleAdmission = resolve; });
        // Register before invoking the port. A synchronous/re-entrant
        // terminate() from port code must still see this host effect as
        // admitted and must not publish a crash before it settles.
        active.bridgeTasks.add(admittedTask);
        try {
          await this.onBridgeRequest(worker, handlerToken, handlerGeneration, active, call);
        } finally {
          settleAdmission();
          active.bridgeTasks.delete(admittedTask);
          if (this.activeProtocol === active && this.job === active.job) {
            active.outstandingBridgeCalls -= 1;
            if (active.outstandingBridgeCalls === 0 && active.deferredFinished) {
              const deferred = active.deferredFinished;
              active.deferredFinished = undefined;
              // Cancellation can be accepted after the worker's terminal frame
              // was deferred but before the last admitted host effect settles.
              // Re-check host authority at publication, not only at receipt.
              this.finish(
                deferred.worker,
                this.enforceCancellationAuthority(deferred.result, active),
              );
            }
          }
        }
        return;
      }
      if (type === "finished") {
        const validated = this.validateFinishedFrame(event.data, handlerToken, handlerGeneration);
        const active = this.activeProtocolFor(validated.jobId);
        const result = this.enforceCancellationAuthority(validated, active);
        if (active.deferredFinished) protocolError("The worker sent more than one finished frame.");
        if (active.outstandingBridgeCalls > 0) {
          // A bridge implementation can depend on a job queued behind this
          // one. Mark the terminal frame first, then settle that queue before
          // waiting for already-admitted effects. This also makes a re-entrant
          // duplicate frame fail closed instead of replacing the first result.
          active.deferredFinished = { worker, result };
          this.state = "draining";
          this.settleCancelledQueuedJobs(
            this.queue.splice(0),
            PYODIDE_DEPENDENCY_CYCLE_CANCELLATION,
          );
          return;
        }
        this.finish(worker, result);
        return;
      }
      protocolError("The Pyodide worker sent an unknown or out-of-phase frame type.");
    } catch (error) {
      const detail = error instanceof PyodideProtocolError ? error.message : "frame validation failed.";
      this.protocolViolation(worker, detail);
    }
  }

  private activeProtocolFor(jobId: string): ActiveProtocol {
    const active = this.activeProtocol;
    if (!active || this.job !== active.job || active.job.jobId !== jobId) {
      return protocolError("The worker frame is not bound to the active Pyodide job.");
    }
    return active;
  }

  private onStreamFrame(
    frame: unknown,
    type: "stdout" | "stderr",
    token: string,
    generation: number,
  ): void {
    const message = plainRecord(
      frame,
      `${type} frame`,
      ["type", "protocol", "protocolToken", "generation", "jobId", "text"],
    );
    validateEnvelope(message, token, generation);
    if (message.type !== type) protocolError(`${type} frame type mismatch.`);
    const jobId = validateJobId(message.jobId, `${type} frame.jobId`);
    const active = this.activeProtocolFor(jobId);
    const text = requiredString(message.text, `${type} frame.text`, this.budgets.maxStreamChars, true);
    if (active.streamFrames >= MAX_KERNEL_STREAM_FRAMES) {
      protocolError("stream frames exceed the per-job frame-count budget.");
    }
    const charge = text.length + KERNEL_STREAM_FRAME_OVERHEAD_CHARS;
    if (type === "stdout") {
      if (active.stdoutCharge + charge > this.budgets.maxStreamChars) {
        protocolError("stdout frames exceed the per-job stream budget.");
      }
      active.stdoutCharge += charge;
      active.stdout.push(text);
    } else {
      if (active.stderrCharge + charge > this.budgets.maxStreamChars) {
        protocolError("stderr frames exceed the per-job stream budget.");
      }
      active.stderrCharge += charge;
      active.stderr.push(text);
    }
    active.streamFrames += 1;
    this.emit({ type, jobId, text });
  }

  private validateBridgeRequest(
    frame: unknown,
    token: string,
    generation: number,
  ): KernelBridgeCallRequest {
    const message = plainRecord(
      frame,
      "bridge-request frame",
      ["type", "protocol", "protocolToken", "generation", "jobId", "call"],
    );
    validateEnvelope(message, token, generation);
    if (message.type !== "bridge-request") protocolError("bridge-request frame type mismatch.");
    const jobId = validateJobId(message.jobId, "bridge-request frame.jobId");
    const active = this.activeProtocolFor(jobId);
    const call = plainRecord(message.call, "bridge-request frame.call", ["jobId", "seq", "tool", "arguments"]);
    if (validateJobId(call.jobId, "bridge-request frame.call.jobId") !== jobId) {
      protocolError("The bridge request carries conflicting job ids.");
    }
    const seq = requiredSafeInteger(call.seq, "bridge-request frame.call.seq");
    if (seq !== active.nextBridgeSeq) protocolError("The bridge sequence is duplicate or out of order.");
    if (seq >= this.budgets.maxBridgeCallsPerJob) protocolError("The worker exceeded maxBridgeCallsPerJob.");
    const tool = requiredString(call.tool, "bridge-request frame.call.tool", MAX_KERNEL_TOOL_NAME_CHARS);
    assertBoundedJsonValue(call.arguments, "bridge-request frame.call.arguments", this.budgets.maxBridgePayloadBytes);
    active.nextBridgeSeq += 1;
    return Object.freeze({ jobId, seq, tool, arguments: call.arguments });
  }

  private async onBridgeRequest(
    worker: KernelWorkerLike,
    token: string,
    generation: number,
    active: ActiveProtocol,
    call: KernelBridgeCallRequest,
  ): Promise<void> {
    this.emit({
      type: "bridge-call",
      jobId: call.jobId,
      seq: call.seq,
      tool: call.tool,
      arguments: call.arguments,
    });
    let result: KernelBridgeCallResult;
    try {
      const raw: unknown = await this.ports.bridge.call(call, active.job.spec.label);
      result = this.validateBridgeResult(raw, call.seq);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .slice(0, Math.max(1, this.budgets.maxBridgePayloadBytes));
      result = Object.freeze({ seq: call.seq, ok: false, error: detail || "The tool call failed." });
    }

    if (
      worker !== this.worker
      || token !== this.protocolToken
      || generation !== this.protocolGeneration
      || this.activeProtocol !== active
      || this.job !== active.job
      || active.deferredFinished
    ) return;
    this.emit({ type: "bridge-result", jobId: call.jobId, seq: call.seq, ok: result.ok });
    worker.postMessage(protocolFrame(
      { type: "bridge-response", jobId: call.jobId, call: result },
      token,
      generation,
    ));
  }

  private validateBridgeResult(value: unknown, expectedSeq: number): KernelBridgeCallResult {
    const record = plainRecord(value, "bridge result", ["seq", "ok"], ["content", "error", "metadata"]);
    const seq = requiredSafeInteger(record.seq, "bridge result.seq");
    if (seq !== expectedSeq) protocolError("The bridge result sequence does not match its request.");
    if (record.ok !== true && record.ok !== false) protocolError("bridge result.ok must be boolean.");
    if (record.metadata !== undefined) {
      assertBoundedJsonValue(record.metadata, "bridge result.metadata", this.budgets.maxBridgePayloadBytes);
    }
    if (record.ok === true) {
      const content = requiredString(record.content, "bridge result.content", this.budgets.maxBridgePayloadBytes, true);
      const result = record.metadata === undefined
        ? { seq, ok: true as const, content }
        : { seq, ok: true as const, content, metadata: record.metadata };
      assertBoundedJsonValue(result, "bridge result", this.budgets.maxBridgePayloadBytes);
      return Object.freeze(result);
    }
    const error = requiredString(record.error, "bridge result.error", this.budgets.maxBridgePayloadBytes);
    const result = record.metadata === undefined
      ? { seq, ok: false as const, error }
      : { seq, ok: false as const, error, metadata: record.metadata };
    assertBoundedJsonValue(result, "bridge result", this.budgets.maxBridgePayloadBytes);
    return Object.freeze(result);
  }

  private validateFinishedFrame(
    frame: unknown,
    token: string,
    generation: number,
  ): KernelJobResult {
    const message = plainRecord(
      frame,
      "finished frame",
      ["type", "protocol", "protocolToken", "generation", "jobId", "result"],
    );
    validateEnvelope(message, token, generation);
    if (message.type !== "finished") protocolError("finished frame type mismatch.");
    const jobId = validateJobId(message.jobId, "finished frame.jobId");
    const active = this.activeProtocolFor(jobId);
    const result = plainRecord(
      message.result,
      "finished frame.result",
      ["jobId", "engine", "outcome", "stdout", "stderr", "bridgeCalls", "wallMs"],
      ["valueJson", "error"],
    );
    if (validateJobId(result.jobId, "finished frame.result.jobId") !== jobId) {
      protocolError("The finished frame carries conflicting job ids.");
    }
    if (result.engine !== "pyodide") protocolError("The finished result engine is invalid.");
    if (result.outcome !== "completed" && result.outcome !== "failed" && result.outcome !== "cancelled") {
      protocolError("The finished result outcome is invalid.");
    }
    const stdout = requiredString(result.stdout, "finished frame.result.stdout", this.budgets.maxStreamChars, true);
    const stderr = requiredString(result.stderr, "finished frame.result.stderr", this.budgets.maxStreamChars, true);
    if (stdout !== active.stdout.join("") || stderr !== active.stderr.join("")) {
      protocolError("The finished streams do not match authenticated stream frames.");
    }
    const bridgeCalls = requiredSafeInteger(
      result.bridgeCalls,
      "finished frame.result.bridgeCalls",
      this.budgets.maxBridgeCallsPerJob,
    );
    if (bridgeCalls !== active.nextBridgeSeq) {
      protocolError("The finished bridge-call count does not match the accepted sequence.");
    }
    const wallMs = requiredSafeInteger(result.wallMs, "finished frame.result.wallMs");

    if (result.outcome === "completed") {
      if (result.error !== undefined) protocolError("A completed result cannot carry an error.");
      if (result.valueJson === undefined) {
        return Object.freeze({
          jobId, engine: "pyodide", outcome: "completed", stdout, stderr, bridgeCalls, wallMs,
        });
      }
      const valueJson = requiredString(
        result.valueJson,
        "finished frame.result.valueJson",
        this.budgets.maxValueBytes,
        true,
      );
      if (protocolEncoder.encode(valueJson).byteLength > this.budgets.maxValueBytes) {
        protocolError("The finished value exceeds maxValueBytes.");
      }
      try {
        JSON.parse(valueJson);
      } catch {
        protocolError("The finished valueJson is not valid JSON.");
      }
      return Object.freeze({
        jobId, engine: "pyodide", outcome: "completed", valueJson, stdout, stderr, bridgeCalls, wallMs,
      });
    }

    if (result.valueJson !== undefined) protocolError("A failed or cancelled result cannot carry valueJson.");
    const error = requiredString(result.error, "finished frame.result.error", this.budgets.maxStreamChars);
    return Object.freeze({
      jobId,
      engine: "pyodide",
      outcome: result.outcome,
      error,
      stdout,
      stderr,
      bridgeCalls,
      wallMs,
    });
  }

  private enforceCancellationAuthority(
    result: KernelJobResult,
    active: ActiveProtocol,
  ): KernelJobResult {
    if (active.cancelRequested === undefined || result.outcome === "cancelled") return result;
    const error = (
      `Kernel cancellation was requested by host authority (${active.cancelRequested}); `
      + "a later worker completion cannot override that cancellation."
    ).slice(0, Math.max(1, this.budgets.maxStreamChars));
    return Object.freeze({
      jobId: result.jobId,
      engine: "pyodide" as const,
      outcome: "cancelled" as const,
      error,
      stdout: result.stdout,
      stderr: result.stderr,
      bridgeCalls: result.bridgeCalls,
      wallMs: result.wallMs,
    });
  }

  private stampBoot(result: KernelJobResult): KernelJobResult {
    if (!this.pendingBootStamp || this.generationBootMs === undefined) return result;
    this.pendingBootStamp = false;
    return Object.freeze({ ...result, bootMs: this.generationBootMs });
  }

  private finish(worker: KernelWorkerLike, result: KernelJobResult): void {
    if (worker !== this.worker) return;
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    if (this.cancelGraceTimer) {
      clearTimeout(this.cancelGraceTimer);
      this.cancelGraceTimer = undefined;
    }
    const stamped = this.stampBoot(result);
    const job = this.job;
    this.job = undefined;
    this.activeProtocol = undefined;
    if (job) {
      job.resolve(stamped);
      this.emit({
        type: stamped.outcome === "completed" ? "completed" : stamped.outcome,
        jobId: stamped.jobId,
        result: stamped,
      }, job.listeners);
    }
    this.state = "ready";
    this.dispatch();
  }

  private protocolViolation(worker: KernelWorkerLike, detail: string): void {
    if (worker !== this.worker) return;
    void this.killWorker(`Pyodide kernel worker protocol violation: ${detail}`);
  }

  private invalidateBoot(): void {
    this.bootEpoch += 1;
    const abort = this.bootAbort;
    this.bootAbort = undefined;
    this.bootPromise = undefined;
    abort?.abort();
  }

  private terminateWorker(
    worker: KernelWorkerLike | undefined,
    token: string | undefined,
    generation: number | undefined,
  ): void {
    if (!worker) return;
    try {
      if (token && generation !== undefined) {
        worker.postMessage(protocolFrame({ type: "terminate" }, token, generation));
      }
    } catch {
      // Worker.terminate is the browser-enforced boundary.
    }
    worker.terminate();
  }

  private settleCancelledQueuedJobs(queuedJobs: QueuedJob[], error: string): void {
    for (const queued of queuedJobs) {
      const result = Object.freeze({
        jobId: queued.jobId,
        engine: "pyodide" as const,
        outcome: "cancelled" as const,
        error,
        stdout: "",
        stderr: "",
        bridgeCalls: 0,
        wallMs: 0,
      });
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId: queued.jobId, result }, queued.listeners);
    }
  }

  private cancelQueuedAfterBootFailure(error: unknown): void {
    const detail = (error instanceof Error ? error.message : String(error))
      .slice(0, Math.max(1, this.budgets.maxStreamChars));
    for (const queued of this.queue.splice(0)) {
      const result = Object.freeze({
        jobId: queued.jobId,
        engine: "pyodide" as const,
        outcome: "cancelled" as const,
        error: `Pyodide worker failed to boot before this queued job: ${detail || "unknown boot failure"}`,
        stdout: "",
        stderr: "",
        bridgeCalls: 0,
        wallMs: 0,
      });
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId: queued.jobId, result }, queued.listeners);
    }
  }

  private killWorker(reason: string): Promise<void> {
    if (this.killPromise) return this.killPromise;

    // Publish the in-flight operation before performKillWorker runs its
    // synchronous prefix. Queue listeners and bridge ports can re-enter the
    // lifecycle; they must join this exact kill instead of starting another.
    let resolveOperation!: () => void;
    let rejectOperation!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.killPromise = operation;
    void this.performKillWorker(reason).then(
      () => {
        if (this.killPromise === operation) this.killPromise = undefined;
        resolveOperation();
      },
      (error: unknown) => {
        if (this.killPromise === operation) this.killPromise = undefined;
        rejectOperation(error);
      },
    );
    return operation;
  }

  private async performKillWorker(reason: string): Promise<void> {
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    if (this.cancelGraceTimer) {
      clearTimeout(this.cancelGraceTimer);
      this.cancelGraceTimer = undefined;
    }
    const worker = this.worker;
    const token = this.protocolToken;
    const generation = this.protocolGeneration;
    const active = this.activeProtocol;
    const job = this.job;
    const queuedJobs = this.queue.splice(0);
    const admittedBridgeTasks = active ? [...active.bridgeTasks] : [];

    this.state = "draining";
    this.worker = undefined;
    this.protocolToken = undefined;
    this.protocolGeneration = undefined;
    this.activeProtocol = undefined;
    this.job = undefined;
    this.invalidateBoot();
    this.terminateWorker(worker, token, generation);
    if (worker) this.generation += 1;

    // Break a bridge -> queued job -> active terminal-boundary cycle before
    // awaiting the exact host effects admitted at the kill boundary. New exec
    // calls see state=draining and fail admission instead of joining the cycle.
    this.settleCancelledQueuedJobs(
      queuedJobs,
      "Kernel worker was reset while this job was queued; the Python namespace was reset.",
    );

    // Browser worker termination cannot retract a host effect already
    // admitted. Withhold the active crash until every captured task settles,
    // so no reviewed mutation can land after the published terminal result.
    if (admittedBridgeTasks.length > 0) {
      await Promise.allSettled(admittedBridgeTasks);
    }

    if (job) {
      const result = this.stampBoot(Object.freeze({
        jobId: job.jobId,
        engine: "pyodide" as const,
        outcome: "crashed" as const,
        error: reason,
        stdout: active?.job === job ? active.stdout.join("") : "",
        stderr: active?.job === job ? active.stderr.join("") : "",
        bridgeCalls: active?.job === job ? active.nextBridgeSeq : 0,
        wallMs: active?.job === job ? Math.max(0, this.now() - active.startedAt) : 0,
      }));
      job.resolve(result);
      this.emit({ type: "crashed", jobId: job.jobId, result }, job.listeners);
    }

    this.runtimeVersion = undefined;
    this.generationBootMs = undefined;
    this.pendingBootStamp = false;
    this.state = "failed";
  }

  private onWorkerError(worker: KernelWorkerLike, token: string, generation: number): void {
    if (
      worker !== this.worker
      || token !== this.protocolToken
      || generation !== this.protocolGeneration
    ) return;
    void this.killWorker("Pyodide kernel worker crashed; the Python namespace was reset.");
  }

  /**
   * An observer cannot decide whether a job settles.
   *
   * These calls used to run bare, so one throwing subscriber wedged `dispatch`
   * before the exec frame and before the wall-clock timer: the job never
   * settled, the host stayed `busy`, `cancel()` threw again before reaching
   * `ready`, and every later job hung behind it. A listener that threw only on
   * stdout turned a completed job into `crashed` with a worker-protocol
   * violation — a host-side observer bug journaled as a worker crash and a
   * namespace reset.
   */
  private emit(event: KernelJobEvent, jobListeners?: ((event: KernelJobEvent) => void)[]): void {
    const notify = (listener: (event: KernelJobEvent) => void): void => {
      try {
        listener(event);
      } catch {
        // A presentation observer cannot control job settlement.
      }
    };
    for (const listener of this.globalListeners) notify(listener);
    const target = jobListeners ?? this.job?.listeners;
    if (target) for (const listener of target) notify(listener);
  }
}

export { PYODIDE_CANCELLED_AT_BOUNDARY };
