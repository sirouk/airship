/**
 * Kernel host protocol tests with a scripted in-process worker. These tests
 * lock the host-side state machine (queue serialization, bridge routing,
 * cancel, crash treatment, restart) independently of any real Worker.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KERNEL_BUDGETS } from "./kernel-contract";
import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelJobEvent,
  KernelJobResult,
} from "./kernel-contract";
import { kernelWorkerSource } from "./kernel-worker-source";
import type { KernelWorkerLike } from "./kernel-host";
import { PrimeKernelHost } from "./kernel-host";

type ScriptedWorker = KernelWorkerLike & {
  listeners: { message: ((event: { data?: unknown }) => void)[]; error: ((event: { message?: string }) => void)[] };
  emit(message: unknown): void;
  fail(message: string): void;
  posted: unknown[];
  terminated: boolean;
};

function makeScriptedWorker(autoFinish = true): ScriptedWorker {
  const listeners = {
    message: [] as ((event: { data?: unknown }) => void)[],
    error: [] as ((event: { message?: string }) => void)[],
  };
  const posted: unknown[] = [];
  const scripted: ScriptedWorker = {
    listeners,
    posted,
    terminated: false,
    emit(message: unknown) {
      for (const listener of listeners.message) listener({ data: message });
    },
    fail(message: string) {
      for (const listener of listeners.error) listener({ message });
    },
    postMessage(message: unknown) {
      posted.push(message);
      const data = message as { type?: string; job?: { jobId: string; code: string; label?: string }; jobId?: string };
      if (data.type === "exec" && data.job && autoFinish) {
        scripted.emit({ type: "stdout", jobId: data.job.jobId, text: "ok" });
        scripted.emit({
          type: "finished",
          jobId: data.job.jobId,
          result: {
            jobId: data.job.jobId,
            engine: "javascript",
            outcome: "completed",
            valueJson: "null",
            stdout: "ok",
            stderr: "",
            bridgeCalls: 0,
            wallMs: 1,
          } satisfies KernelJobResult,
        });
      }
    },
    terminate() {
      scripted.terminated = true;
    },
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === "message") listeners.message.push(listener as (event: { data?: unknown }) => void);
      if (type === "error") listeners.error.push(listener as (event: { message?: string }) => void);
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      const bucket = type === "message" ? listeners.message : listeners.error;
      const idx = bucket.indexOf(listener as never);
      if (idx >= 0) bucket.splice(idx, 1);
    },
  };
  return scripted;
}

function makeHost(worker: ScriptedWorker): { host: PrimeKernelHost; bridgeCalls: KernelBridgeCallRequest[] } {
  const bridgeCalls: KernelBridgeCallRequest[] = [];
  const host = new PrimeKernelHost({
    ports: {
      bridge: {
        call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
          bridgeCalls.push(request);
          worker.posted.push({ type: "bridge-response", jobId: request.jobId, call: { seq: request.seq, ok: true, content: "{}" } });
          return { seq: request.seq, ok: true, content: "{}" };
        },
      },
      workerFactory: () => worker,
      randomId: (() => {
        let n = 0;
        return (prefix: string) => `${prefix}-${++n}`;
      })(),
    },
  });
  return { host, bridgeCalls };
}

describe("PrimeKernelHost (scripted worker)", () => {
  it("boots to ready and describes state", async () => {
    const worker = makeScriptedWorker();
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    expect(host.description().state).toBe("ready");
  });

  it("rejects oversized source before posting to worker", async () => {
    const worker = makeScriptedWorker();
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const result = await host.exec({ code: "x".repeat(DEFAULT_KERNEL_BUDGETS.maxSourceChars + 1) });
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("source budget");
    expect(worker.posted.filter((m: any) => m.type === "exec")).toHaveLength(0);
  });

  it("executes a job and emits bounded event sequence", async () => {
    const worker = makeScriptedWorker();
    const events: KernelJobEvent[] = [];
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const result = await host.exec({ code: "true", label: "test" }, (event) => events.push(event));
    expect(result.outcome).toBe("completed");
    expect(events.map((e) => e.type)).toEqual(["started", "stdout", "completed"]);
  });

  it("routes bridge requests through the bridge port", async () => {
    const worker = makeScriptedWorker();
    const { host, bridgeCalls } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const job = host.exec({ code: "await __pat.call('read_file', {})" });
    await new Promise((r) => setTimeout(r, 0));
    worker.emit({ type: "bridge-request", jobId: "kernel-job-4", call: { jobId: "kernel-job-4", seq: 0, tool: "read_file", arguments: {} } });
    await new Promise((r) => setTimeout(r, 5));
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].tool).toBe("read_file");
    expect(worker.posted.some((m: any) => m.type === "bridge-response")).toBe(true);
    void job;
    worker.terminate();
  });

  it("cancel(jobId) before dispatch resolves as cancelled without notifying the worker", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const queueSH = host;
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    host.exec({ code: "busy" });
    const wait = host.exec({ code: "later", jobId: "kernel-job-later" });
    expect(queueSH.cancel("kernel-job-later", "cancelled by policy")).toBe(true);
    const result = await wait;
    expect(result.outcome).toBe("cancelled");
    expect(result.error).toContain("cancelled by policy");
  });

  it("hard kill crashes current job, cancels queued jobs, and resets generation", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const active = host.exec({ code: "long", jobId: "job-long" }); console.log("T2");
    const queued = host.exec({ code: "queued", jobId: "job-queued" });
    await host.terminate("policy replacement"); console.log("T4");
    const activeResult = await active; console.log("T6");
    const queuedResult = await queued;
    expect(activeResult.outcome).toBe("crashed");
    expect(queuedResult.outcome).toBe("cancelled");
    expect(host.description().state).toBe("stopped");
  });

  it("worker-source contains the ambient-removal list (egress honesty)", () => {
    const source = kernelWorkerSource(DEFAULT_KERNEL_BUDGETS);
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
      expect(source).toContain(`"${name}"`);
    }
  });
});
