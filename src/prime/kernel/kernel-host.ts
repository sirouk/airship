/**
 * The prime kernel host: a persistent worker lifecycle authority for the
 * RLM execution kernel. It owns:
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

import { kernelWorkerSource } from "./kernel-worker-source";
import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelBudgets,
  KernelJobEvent,
  KernelJobResult,
  KernelJobSpec,
  KernelState,
} from "./kernel-contract";
import { DEFAULT_KERNEL_BUDGETS } from "./kernel-contract";

export type KernelBridgePort = Readonly<{
  /** Route one tool call from kernel code. Approval + journaling policy live on the far side of this port. */
  call(request: KernelBridgeCallRequest, label?: string): Promise<KernelBridgeCallResult>;
}>;

export type KernelHostPorts = Readonly<{
  bridge: KernelBridgePort;
  /** Override worker construction for tests or for TrustedTypes policy injection. */
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
  listeners: ((event: KernelJobEvent) => void)[];
};

const WORKER_POLICY_NAME = "prime-kernel-worker";
let workerPolicy: TrustedTypePolicy | undefined;

interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): TrustedTypePolicy;
}

interface TrustedTypePolicy {
  createScriptURL(value: string): unknown;
}

/**
 * `require-trusted-types-for 'script'` also covers Worker constructors. The
 * policy accepts only a blob URL minted immediately from kernel-owned
 * source; it is not a generic string-to-script escape hatch. Mirrors
 * airship's trustedWorkerUrl rule exactly.
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

function defaultRandomId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export class PrimeKernelHost {
  private readonly budgets: KernelBudgets;
  private readonly ports: KernelHostPorts;
  private readonly now: () => number;
  private readonly randomId: (prefix: string) => string;

  private state: KernelState = "booting";
  private worker?: KernelWorkerLike;
  private job?: QueuedJob;
  private readonly queue: QueuedJob[] = [];
  private jobTimer?: ReturnType<typeof setTimeout>;
  private bootPromise?: Promise<void>;
  private generation = 0;
  private globalListeners: ((event: KernelJobEvent) => void)[] = [];

  constructor(options: KernelHostOptions) {
    this.budgets = { ...DEFAULT_KERNEL_BUDGETS, ...options.budgets };
    this.ports = options.ports;
    this.now = options.ports.now ?? (() => Date.now());
    this.randomId = options.ports.randomId ?? defaultRandomId;
  }

  description(): { state: KernelState; engine: "javascript"; generation: number; queuedJobs: number } {
    return { state: this.state, engine: "javascript", generation: this.generation, queuedJobs: this.queue.length + (this.job ? 1 : 0) };
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
    await this.start();
    const jobId = spec.jobId ?? this.randomId("kernel-job");
    if (spec.code.length > this.budgets.maxSourceChars) {
      return {
        jobId, engine: "javascript", outcome: "failed",
        error: `Kernel job source exceeds the source budget (${spec.code.length} chars > ${this.budgets.maxSourceChars}).`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
    }
    if (this.queue.length >= this.budgets.maxQueuedJobs) {
      return {
        jobId, engine: "javascript", outcome: "failed",
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

  cancel(jobId: string, reason?: string): boolean {
    const index = this.queue.findIndex((entry) => entry.jobId === jobId);
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1);
      const result: KernelJobResult = {
        jobId, engine: "javascript", outcome: "cancelled", error: reason ?? "Cancelled before execution.",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId, result });
      return true;
    }
    if (this.job && this.job.jobId === jobId) {
      this.worker?.postMessage({ type: "cancel", jobId, reason });
      return true;
    }
    return false;
  }

  async terminate(reason = "Kernel terminated by host policy."): Promise<void> {
    await this.killWorker(reason);
    this.state = "stopped";
  }

  async restart(): Promise<void> {
    await this.killWorker("Kernel restarted by host policy.");
    this.bootPromise = undefined;
    this.generation++;
    await this.start();
  }


  private async bootWorker(): Promise<void> {
    if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
      this.state = "failed";
      throw new Error("The prime kernel requires browser Workers and URL.createObjectURL.");
    }
    const source = kernelWorkerSource(this.budgets);
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = this.ports.workerFactory
      ? this.ports.workerFactory()
      : (new Worker(trustedWorkerUrl(url) as string, { name: "prime-kernel" }) as unknown as KernelWorkerLike);
    this.worker = worker;
    this.state = "booting";

    await new Promise<void>((resolve, reject) => {
      const onMessage = (event: { data?: unknown }) => {
        const message = event.data as { type?: string };
        if (message && message.type === "ready") {
          worker.removeEventListener("message", onMessage as never);
          this.attachWorkerHandlers(worker);
          this.state = "ready";
          resolve();
        }
      };
      const onError = (event: { message?: string }) => {
        worker.removeEventListener("error", onError as never);
        this.state = "failed";
        reject(new Error(`Kernel worker failed to boot: ${String(event.message ?? "worker error")}`));
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
    this.emit({ type: "started", jobId: queued.jobId, engine: "javascript", label: queued.spec.label });
    const timeout = queued.spec.timeoutMs ?? this.budgets.maxJobWallMs;
    this.jobTimer = setTimeout(() => {
      void this.killWorker(`Kernel job ${queued.jobId} exceeded its wall-clock budget (${timeout} ms).`);
    }, timeout);
    this.worker!.postMessage({ type: "exec", job: { jobId: queued.jobId, code: queued.spec.code, label: queued.spec.label } });
  }

  private async onWorkerMessage(event: { data?: unknown }): Promise<void> {
    const message = event.data as { type?: string } & Record<string, unknown>;
    if (!message || typeof message.type !== "string") return;

    if (message.type === "bridge-request") {
      await this.onBridgeRequest(message as unknown as { jobId: string; call: KernelBridgeCallRequest });
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

    // Only presentation streams are forwarded as-is. Bridge lifecycle events
    // are synthesized by the host around the bridge port so their provenance
    // is always host-attributed, never worker-attributed.
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

  private finish(result: KernelJobResult): void {
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    const job = this.job;
    this.job = undefined;
    if (job) {
      job.resolve(result);
      this.emit({ type: result.outcome === "completed" ? "completed" : result.outcome, jobId: result.jobId, result });
    }
    this.state = "ready";
    this.dispatch();
  }

  private async killWorker(reason: string): Promise<void> {
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
    }
    this.worker?.postMessage({ type: "terminate" });
    this.worker?.terminate();
    this.worker = undefined;
    this.bootPromise = undefined;

    if (this.job) {
      const job = this.job;
      this.job = undefined;
      const result: KernelJobResult = {
        jobId: job.jobId, engine: "javascript", outcome: "crashed", error: reason,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      job.resolve(result);
      this.emit({ type: "crashed", jobId: job.jobId, result });
    }

    for (const queued of this.queue.splice(0)) {
      const result: KernelJobResult = {
        jobId: queued.jobId, engine: "javascript", outcome: "cancelled", error: "Kernel worker was reset while this job was queued; the namespace was reset.",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0,
      };
      queued.resolve(result);
      this.emit({ type: "cancelled", jobId: queued.jobId, result });
    }

    this.state = "failed";
    this.generation++;
  }

  private onWorkerError(): void {
    void this.killWorker("Kernel worker crashed; the namespace was reset.");
  }

  private emit(event: KernelJobEvent): void {
    for (const listener of this.globalListeners) listener(event);
    if (this.job) for (const listener of this.job.listeners) listener(event);
  }
}

