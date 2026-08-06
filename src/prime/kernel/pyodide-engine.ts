/**
 * The pyodide kernel engine: the prime-agent IPython analog
 * (port-manifest §3.1) — a persistent CPython interpreter with a
 * persistent namespace, re-hosted inside airship as the second engine of
 * the prime kernel, next to the baseline javascript engine
 * (kernel-host.ts).
 *
 * Why a sibling class and not an engine flag inside PrimeKernelHost:
 *   - the javascript engine's observable behavior must stay byte-identical,
 *     and folding two lifecycles into one class would touch shared code
 *     paths that existing tests lock;
 *   - the lifecycles genuinely differ: CPython boots asynchronously into a
 *     version-checked ready frame carrying bootMs, answers cancellation
 *     only cooperatively at statement boundaries, and needs a named
 *     grace-and-terminate escalation the synchronous javascript worker
 *     does not have. Those differences live here, in full, so neither
 *     engine's honesty is diluted by the other.
 *
 * What is deliberately identical to PrimeKernelHost: the public surface
 * (start/exec/cancel/terminate/restart/onEvent/describe), the serialized
 * one-cell-at-a-time dispatch (semantic invariant 24), the bridge port as
 * the only egress, host-owned queue/budget policy, and outcome vocabulary.
 * Layering is identical too: this file imports only from kernel sibling
 * modules; approvals, tools, and the journal live behind the bridge port.
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
import { DEFAULT_KERNEL_BUDGETS } from "./kernel-contract";
import type { KernelHostPorts, KernelWorkerLike } from "./kernel-host";
import { kernelTrustedWorkerUrl } from "./kernel-host";
import {
  PYODIDE_CANCELLED_AT_BOUNDARY,
  pyodideKernelWorkerSource,
} from "./pyodide-worker-source";

/**
 * Pinned pyodide pack version. The same pin lives in
 * scripts/pyodide-assets.ts (which serves the real pack only when
 * node_modules/pyodide/package.json matches it) and in
 * src/tools/execution-tools.ts; the producer and all validators agree on
 * the string without importing each other's module. The engine additionally
 * fails closed when the live worker's runtime reports anything else.
 */
export const PYODIDE_VERSION = "314.0.2";
/** Same-origin mount point of the pinned pyodide pack (vite plugin scripts/pyodide-assets.ts). */
export const PYODIDE_ASSET_PATH = "/execution-packs/pyodide/";
/**
 * Grace window between a cooperative cancellation and the hard terminate.
 * CPython honors the flag only at statement boundaries, so a busy
 * pure-Python loop may outlive the flag; after this many milliseconds of
 * silence the worker is terminated and the outcome is named crashed, with
 * the namespace reset stated. 500 ms mirrors the upstream kernel's
 * interrupt-cadence cadence class (manifest §3.1: 500 ms interrupt
 * cadence) rather than inventing a new number.
 */
export const PYODIDE_TERMINATE_GRACE_MS = 500;
/** Worker name; pairs with the module-worker construction airship uses for its pyodide worker. */
const PYODIDE_WORKER_NAME = "prime-kernel-pyodide";

export type PyodideKernelHostPorts = KernelHostPorts &
  Readonly<{
    /**
     * Base location of the pinned pyodide pack, ending in "/". In the page
     * this defaults to PYODIDE_ASSET_PATH resolved against the document;
     * non-browser hosts (vitest live lane, node) must pass it explicitly.
     */
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

function defaultRandomId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

/** The pack base must end in a separator: the worker concatenates "pyodide.mjs" onto it. */
function normalizeAssetBase(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

function defaultAssetBase(): string {
  const location = (globalThis as { location?: { href?: string } }).location;
  if (!location || typeof location.href !== "string") {
    throw new Error(
      "The pyodide kernel needs ports.assetBase when globalThis.location is unavailable (non-browser hosts must name the pinned pack location).",
    );
  }
  return new URL(PYODIDE_ASSET_PATH, location.href).href;
}

export class PyodideKernelEngine {
  private readonly budgets: KernelBudgets;
  private readonly ports: PyodideKernelHostPorts;
  private readonly now: () => number;
  private readonly randomId: (prefix: string) => string;

  private state: KernelState = "booting";
  private worker?: KernelWorkerLike;
  private job?: QueuedJob;
  private readonly queue: QueuedJob[] = [];
  private jobTimer?: ReturnType<typeof setTimeout>;
  private cancelGraceTimer?: ReturnType<typeof setTimeout>;
  private bootPromise?: Promise<void>;
  private generation = 0;
  private globalListeners: ((event: KernelJobEvent) => void)[] = [];
  /**
   * bootMs of the current worker generation, stamped onto the generation's
   * FIRST job result (all outcomes) and onto describe(); undefined again
   * after the stamp so exactly one result per generation carries it.
   */
  private generationBootMs?: number;
  private pendingBootStamp = false;
  private runtimeVersion?: string;

  constructor(options: PyodideKernelEngineOptions) {
    this.budgets = { ...DEFAULT_KERNEL_BUDGETS, ...options.budgets };
    this.ports = options.ports;
    this.now = options.ports.now ?? (() => Date.now());
    this.randomId = options.ports.randomId ?? defaultRandomId;
  }

  /* Parity with PrimeKernelHost.description(), with the engine literal changed. */
  description(): { state: KernelState; engine: "pyodide"; generation: number; queuedJobs: number } {
    return { state: this.state, engine: "pyodide", generation: this.generation, queuedJobs: this.queue.length + (this.job ? 1 : 0) };
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
    this.bootPromise ??= this.bootWorker();
    await this.bootPromise;
  }

  async exec(spec: KernelJobSpec, listener?: (event: KernelJobEvent) => void): Promise<KernelJobResult> {
    if (!this.bootPromise || this.state === "failed" || this.state === "stopped") {
      await this.start();
    }
    const jobId = spec.jobId ?? this.randomId("kernel-job");
    if (spec.code.length > this.budgets.maxSourceChars) {
      return {
        jobId, engine: "pyodide", outcome: "failed",
        error: `Kernel job source exceeds the source budget (${spec.code.length} chars > ${this.budgets.maxSourceChars}).`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    if (this.queue.length >= this.budgets.maxQueuedJobs) {
      return {
        jobId, engine: "pyodide", outcome: "failed",
        error: `Kernel job queue is full (${this.budgets.maxQueuedJobs} queued jobs).`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    return new Promise<KernelJobResult>((resolve) => {
      const queued: QueuedJob = { spec, jobId, resolve, listeners: listener ? [listener] : [] };
      this.queue.push(queued);
      this.dispatch();
    });
  }

  /*
   * Cancellation ladder: queued jobs resolve cancelled immediately; the
   * active job gets the cooperative cancel frame, then the escalation
   * timer arms the hard boundary. A job that settles inside the grace
   * window resolves with the worker's own outcome (its error text names a
   * cancelled-with-boundary landing); a job that outlives the grace is
   * terminated and named crashed, with the namespace reset stated.
   */
  cancel(jobId: string, reason?: string): boolean {
    const index = this.queue.findIndex((entry) => entry.jobId === jobId);
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1);
      const result: KernelJobResult = {
        jobId, engine: "pyodide", outcome: "cancelled", error: reason ?? "Cancelled before execution.",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      const stamped = this.stampBoot(result);
      queued.resolve(stamped);
      this.emit({ type: "cancelled", jobId, result: stamped }, queued.listeners);
      return true;
    }
    if (this.job && this.job.jobId === jobId) {
      this.worker?.postMessage({ type: "cancel", jobId, reason });
      this.armCancelGrace(jobId, reason ?? "kernel job cancelled");
      return true;
    }
    return false;
  }

  async terminate(reason = "Kernel terminated by host policy."): Promise<void> {
    await this.killWorker(reason);
    this.state = "stopped";
  }

  /*
   * Restart is reported, never hidden: the killed jobs name the reset, the
   * generation increments, and the namespace guarantee restarts empty —
   * there is deliberately no snapshot/restore here (deferred seam, see
   * PORT.md), because a silent partial revival is worse than a stated,
   * complete reset.
   */
  async restart(): Promise<void> {
    await this.killWorker("Kernel restarted by host policy; the Python namespace was reset.");
    this.bootPromise = undefined;
    this.generation++;
    await this.start();
  }

  private async bootWorker(): Promise<void> {
    let worker: KernelWorkerLike;
    if (this.ports.workerFactory) {
      worker = this.ports.workerFactory();
    } else {
      if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
        this.state = "failed";
        throw new Error("The pyodide kernel requires browser Workers and URL.createObjectURL.");
      }
      const assetBase = normalizeAssetBase(this.ports.assetBase ?? defaultAssetBase());
      const source = pyodideKernelWorkerSource(this.budgets, assetBase);
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      // Module worker, mirroring airship's pyodide worker construction
      // exactly (src/tools/execution-tools.ts): the worker imports the pack
      // as an ES module; the trusted-types policy is the same blob-only
      // mint the javascript engine uses.
      worker = new Worker(kernelTrustedWorkerUrl(url) as string, { name: PYODIDE_WORKER_NAME, type: "module" }) as unknown as KernelWorkerLike;
    }
    this.worker = worker;
    this.state = "booting";

    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        worker.removeEventListener("message", onMessage as never);
        worker.removeEventListener("error", onError as never);
        if (error) {
          this.state = "failed";
          reject(error);
        } else {
          this.attachWorkerHandlers(worker);
          this.state = "ready";
          resolve();
        }
      };
      const onMessage = (event: { data?: unknown }) => {
        const message = event.data as { type?: string; bootMs?: unknown; version?: unknown; error?: unknown };
        if (!message || typeof message.type !== "string") return;
        if (message.type === "boot-failed") {
          settle(new Error(`Pyodide kernel failed to boot: ${typeof message.error === "string" ? message.error : "unknown boot error"}`));
          return;
        }
        if (message.type !== "ready") return;
        const reportedVersion = typeof message.version === "string" ? message.version : "unknown";
        if (reportedVersion !== PYODIDE_VERSION) {
          settle(new Error(
            `Pyodide kernel asset/pin mismatch: the worker reports pyodide@${reportedVersion} but the engine is pinned to pyodide@${PYODIDE_VERSION}. ` +
            `Refresh ${PYODIDE_ASSET_PATH} to the pinned pack before starting kernel jobs.`,
          ));
          return;
        }
        this.runtimeVersion = reportedVersion;
        const bootMs = typeof message.bootMs === "number" && Number.isFinite(message.bootMs) ? message.bootMs : undefined;
        this.generationBootMs = bootMs;
        this.pendingBootStamp = bootMs !== undefined;
        settle();
      };
      const onError = (event: { message?: string }) => {
        settle(new Error(`Pyodide kernel worker failed to boot: ${String(event.message ?? "worker error")}`));
      };
      worker.addEventListener("message", onMessage as never);
      worker.addEventListener("error", onError as never);
    });
  }

  private attachWorkerHandlers(worker: KernelWorkerLike): void {
    worker.addEventListener("message", ((event: { data?: unknown }) => this.onWorkerMessage(event)) as never);
    worker.addEventListener("error", (() => this.onWorkerError()) as never);
  }

  private dispatch(): void {
    if (this.state !== "ready" || this.job) return;
    const queued = this.queue.shift();
    if (!queued) return;
    this.job = queued;
    this.state = "busy";
    this.emit({ type: "started", jobId: queued.jobId, engine: "pyodide", label: queued.spec.label });
    const timeout = queued.spec.timeoutMs ?? this.budgets.maxJobWallMs;
    /*
     * The wall-clock budget escalates through the same ladder as a manual
     * cancel — cooperative cancel frame first, terminate after the named
     * grace. Pyodide cannot interrupt a statement, so an instant kill here
     * would skip the one cancellation shape the interpreter can honor.
     */
    this.jobTimer = setTimeout(() => {
      const reason = `Kernel job ${queued.jobId} exceeded its wall-clock budget (${timeout} ms).`;
      this.worker?.postMessage({ type: "cancel", jobId: queued.jobId, reason });
      this.armCancelGrace(queued.jobId, reason);
    }, timeout);
    this.worker!.postMessage({ type: "exec", job: { jobId: queued.jobId, code: queued.spec.code, label: queued.spec.label } });
  }

  private armCancelGrace(jobId: string, reason: string): void {
    if (this.cancelGraceTimer) clearTimeout(this.cancelGraceTimer);
    this.cancelGraceTimer = setTimeout(() => {
      this.cancelGraceTimer = undefined;
      void this.killWorker(
        `Kernel job ${jobId} did not settle within ${PYODIDE_TERMINATE_GRACE_MS} ms of cooperative cancellation (${reason}); ` +
        "the worker was terminated and the Python namespace was reset, which is the hard cancellation boundary reported in describe().",
      );
    }, PYODIDE_TERMINATE_GRACE_MS);
  }

  private async onWorkerMessage(event: { data?: unknown }): Promise<void> {
    const message = event.data as { type?: string } & Record<string, unknown>;
    if (!message || typeof message.type !== "string") return;

    if (message.type === "bridge-request") {
      await this.onBridgeRequest(message as unknown as { jobId: string; call: KernelBridgeCallRequest });
      return;
    }

    if (message.type === "boot-failed") {
      void this.killWorker(`Pyodide kernel reported a late boot failure: ${typeof message.error === "string" ? message.error : "unknown boot error"}`);
      return;
    }

    if (message.type === "ready") {
      if (this.state === "booting" || this.state === "failed" || this.state === "stopped") this.state = "ready";
      return;
    }

    if (message.type === "finished") {
      const result = (message as { result: KernelJobResult }).result;
      this.finish(result);
      return;
    }

    // Same provenance rule as the javascript host: presentation streams are
    // forwarded as-is; bridge lifecycle events are synthesized host-side.
    if (message.type === "stdout" || message.type === "stderr") {
      const event = message as unknown as KernelJobEvent & { jobId?: string };
      if (event.jobId) this.emit(event as KernelJobEvent);
    }
  }

  private async onBridgeRequest(message: { jobId: string; call: KernelBridgeCallRequest }): Promise<void> {
    const call = message.call;
    this.emit({ type: "bridge-call", jobId: call.jobId, seq: call.seq, tool: call.tool, arguments: call.arguments });
    let result: KernelBridgeCallResult;
    try {
      result = await this.ports.bridge.call(call, this.job?.spec.label);
    } catch (error) {
      result = { seq: call.seq, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.emit({ type: "bridge-result", jobId: call.jobId, seq: call.seq, ok: result.ok });
    this.worker?.postMessage({ type: "bridge-response", jobId: call.jobId, call: result });
  }

  /** bootMs is stamped exactly once per worker generation, onto the first result of that generation. */
  private stampBoot(result: KernelJobResult): KernelJobResult {
    if (!this.pendingBootStamp || this.generationBootMs === undefined) return result;
    this.pendingBootStamp = false;
    return Object.freeze({ ...result, bootMs: this.generationBootMs });
  }

  private finish(result: KernelJobResult): void {
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
    if (job) {
      job.resolve(stamped);
      this.emit({ type: stamped.outcome === "completed" ? "completed" : stamped.outcome, jobId: stamped.jobId, result: stamped }, job.listeners);
    }
    this.state = "ready";
    this.dispatch();
  }

  private async killWorker(reason: string): Promise<void> {
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    if (this.cancelGraceTimer) {
      clearTimeout(this.cancelGraceTimer);
      this.cancelGraceTimer = undefined;
    }
    this.worker?.postMessage({ type: "terminate" });
    this.worker?.terminate();
    this.worker = undefined;
    this.bootPromise = undefined;
    this.runtimeVersion = undefined;

    if (this.job) {
      const job = this.job;
      this.job = undefined;
      const result: KernelJobResult = {
        jobId: job.jobId, engine: "pyodide", outcome: "crashed", error: reason,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      const stamped = this.stampBoot(result);
      job.resolve(stamped);
      this.emit({ type: "crashed", jobId: job.jobId, result: stamped }, job.listeners);
    }

    for (const queued of this.queue.splice(0)) {
      const result: KernelJobResult = {
        jobId: queued.jobId, engine: "pyodide", outcome: "cancelled",
        error: "Kernel worker was reset while this job was queued; the Python namespace was reset.",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId: queued.jobId, result }, queued.listeners);
    }

    this.state = "failed";
    this.generation++;
  }

  private onWorkerError(): void {
    void this.killWorker("Pyodide kernel worker crashed; the Python namespace was reset.");
  }

  private emit(event: KernelJobEvent, jobListeners?: ((event: KernelJobEvent) => void)[]): void {
    for (const listener of this.globalListeners) listener(event);
    const target = jobListeners ?? this.job?.listeners;
    if (target) for (const listener of target) listener(event);
  }
}

/* Re-exported so callers composing cancel text can match the worker's naming without importing worker internals. */
export { PYODIDE_CANCELLED_AT_BOUNDARY };
