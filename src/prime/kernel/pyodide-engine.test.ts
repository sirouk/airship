/**
 * Pyodide kernel engine tests, two lanes in one file:
 *
 *   1. "PyodideKernelEngine (scripted worker)" — always on. An in-process
 *      scripted worker locks the host-side state machine: ready handshake
 *      with version check, serialized dispatch, bridge routing, the
 *      cooperative-cancel-then-terminate ladder, boot-failed treatment,
 *      restart/generation semantics, and once-per-generation bootMs
 *      stamping. No pyodide bytes are loaded here.
 *
 *   2. "PyodideKernelEngine (live pinned pack)" — gated by PRIME_PYODIDE_LIVE=1,
 *      off by default in CI. It constructs the engine against the REAL
 *      pinned pyodide pack served from node_modules/pyodide via a
 *      node:worker_threads workerFactory seam (the same message protocol,
 *      filesystem asset base; no network), and asserts the port semantics
 *      end to end: boot, persistent namespace across jobs, pat.call round
 *      trip, streaming, jupyter-shaped errors, cancel-at-a-boundary with
 *      the namespace surviving, graceful-terminate escalation, restart
 *      resetting the namespace, value/payload budget markers.
 *
 *      Run it with:
 *        PRIME_PYODIDE_LIVE=1 npx vitest run src/prime/kernel/pyodide-engine.test.ts
 */

import { readFileSync } from "node:fs";
import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_WORKER_AMBIENT_GLOBALS,
  DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
  DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
} from "../../execution/disposable-worker-isolation-source";
import { DEFAULT_KERNEL_BUDGETS } from "./kernel-contract";
import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelBudgets,
  KernelJobEvent,
  KernelJobResult,
  KernelJobSpec,
} from "./kernel-contract";
import type { KernelWorkerLike } from "./kernel-host";
import { PrimeKernelHost } from "./kernel-host";
import {
  PYODIDE_ENGINE_QUARANTINE_MESSAGE,
  PyodideEngineQuarantinedError,
  createKernelEngine,
} from "./engines";
import {
  PAT_KERNEL_VERSION,
  PYODIDE_CANCELLED_AT_BOUNDARY,
  PYODIDE_KERNEL_PROTOCOL_VERSION,
  pyodideKernelWorkerSource,
} from "./pyodide-worker-source";
import {
  PYODIDE_ASSET_PATH,
  PYODIDE_TERMINATE_GRACE_MS,
  PYODIDE_VERSION,
  PyodideKernelEngine,
  pyodideAssetPathForBase,
} from "./pyodide-engine";

/* ------------------------------------------------------------------ */
/* Lane 1: scripted in-process worker                                  */
/* ------------------------------------------------------------------ */

type ScriptedWorker = KernelWorkerLike & {
  listeners: {
    message: ((event: { data?: unknown; isTrusted?: boolean }) => void)[];
    error: ((event: { message?: string }) => void)[];
  };
  emit(message: unknown, options?: { authenticate?: boolean; trusted?: boolean }): void;
  fail(message: string): void;
  posted: unknown[];
  terminated: boolean;
};

function makeScriptedWorker(autoFinish = true): ScriptedWorker {
  const listeners = {
    message: [] as ((event: { data?: unknown; isTrusted?: boolean }) => void)[],
    error: [] as ((event: { message?: string }) => void)[],
  };
  const posted: unknown[] = [];
  let protocolToken: string | undefined;
  let generation: number | undefined;
  const scripted: ScriptedWorker = {
    listeners,
    posted,
    terminated: false,
    emit(message: unknown, options = {}) {
      const record = message as Record<string, unknown>;
      const data = options.authenticate === false || protocolToken === undefined || generation === undefined
        ? message
        : {
            ...record,
            protocol: PYODIDE_KERNEL_PROTOCOL_VERSION,
            protocolToken,
            generation,
          };
      for (const listener of [...listeners.message]) {
        listener({ data, isTrusted: options.trusted ?? true });
      }
    },
    fail(message: string) {
      for (const listener of [...listeners.error]) listener({ message });
    },
    postMessage(message: unknown) {
      posted.push(message);
      const data = message as {
        type?: string;
        protocolToken?: string;
        generation?: number;
        job?: { jobId: string; code: string; label?: string };
      };
      if (data.type === "init") {
        protocolToken = data.protocolToken;
        generation = data.generation;
      }
      if (data.type === "exec" && data.job && autoFinish) {
        scripted.emit({
          type: "finished",
          jobId: data.job.jobId,
          result: {
            jobId: data.job.jobId,
            engine: "pyodide",
            outcome: "completed",
            valueJson: "null",
            stdout: "",
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
      if (type === "message") listeners.message.push(listener as (event: { data?: unknown; isTrusted?: boolean }) => void);
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

function readyScriptedWorker(worker: ScriptedWorker, bootMs = 120): void {
  worker.emit({ type: "ready", engine: "pyodide", bootMs, version: PYODIDE_VERSION });
}

function makeEngine(
  worker: ScriptedWorker,
  budgets?: Partial<KernelBudgets>,
): { engine: PyodideKernelEngine; bridgeCalls: KernelBridgeCallRequest[] } {
  const bridgeCalls: KernelBridgeCallRequest[] = [];
  const engine = new PyodideKernelEngine({
    budgets,
    ports: {
      bridge: {
        call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
          bridgeCalls.push(request);
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
  return { engine, bridgeCalls };
}

function postedOfType(worker: ScriptedWorker, type: string): unknown[] {
  return worker.posted.filter((message) => (message as { type?: string }).type === type);
}

describe("PyodideKernelEngine (scripted worker)", () => {
  it("boots via ready, captures bootMs/runtimeVersion, and exposes the honest capability record", async () => {
    const worker = makeScriptedWorker();
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker, 321);
    await boot;

    const capability = engine.describe();
    expect(capability.state).toBe("ready");
    expect(capability.engine).toBe("pyodide");
    expect(capability.bootMs).toBe(321);
    expect(capability.version).toBe(PYODIDE_VERSION);
    expect(capability.runtimeVersion).toBe(PYODIDE_VERSION);
    expect(capability.workspaceAccess).toBe("none");
    expect(capability.persistence).toBe("kernel-instance");
    expect(capability.cancellation).toBe("cooperative-then-terminate-worker");
    expect(capability.network).toBe("absent-ambient; tool bridge only");
    expect(engine.description()).toEqual({ state: "ready", engine: "pyodide", generation: 0, queuedJobs: 0 });
  });

  it("fails closed when the worker reports a different pyodide version than the pin", async () => {
    const worker = makeScriptedWorker();
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    worker.emit({ type: "ready", engine: "pyodide", bootMs: 10, version: "0.0.0-not-the-pin" });
    await expect(boot).rejects.toThrow("asset/pin mismatch");
    expect(engine.describe().state).toBe("failed");
  });

  it("rejects boot when the worker posts a boot-failed frame", async () => {
    const worker = makeScriptedWorker();
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    worker.emit({ type: "boot-failed", engine: "pyodide", error: "wasm exploded" });
    await expect(boot).rejects.toThrow("boot");
    expect(engine.describe().state).toBe("failed");
  });

  it("rejects oversized source before posting to the worker", async () => {
    const worker = makeScriptedWorker();
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;
    const result = await engine.exec({ code: "x".repeat(DEFAULT_KERNEL_BUDGETS.maxSourceChars + 1) });
    expect(result.outcome).toBe("failed");
    expect(result.engine).toBe("pyodide");
    expect(result.error).toContain("source budget");
    expect(postedOfType(worker, "exec")).toHaveLength(0);
  });


  it("snapshots every caller-owned job field once before asynchronous boot", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker, { maxSourceChars: 64, maxJobWallMs: 100 });
    const reads = { jobId: 0, code: 0, timeoutMs: 0, label: 0 };
    const backing: { jobId: string; code: string; timeoutMs: number; label: string } = {
      jobId: "job-snapshotted",
      code: "'safe'",
      timeoutMs: 50,
      label: "safe-label",
    };
    const spec = Object.defineProperties({}, {
      jobId: { enumerable: true, get: () => { reads.jobId += 1; return backing.jobId; } },
      code: { enumerable: true, get: () => { reads.code += 1; return backing.code; } },
      timeoutMs: { enumerable: true, get: () => { reads.timeoutMs += 1; return backing.timeoutMs; } },
      label: { enumerable: true, get: () => { reads.label += 1; return backing.label; } },
    }) as KernelJobSpec;

    const pending = engine.exec(spec);
    expect(reads).toEqual({ jobId: 1, code: 1, timeoutMs: 1, label: 1 });
    backing.jobId = "job-mutated";
    backing.code = "'MUTATED_AFTER_ADMISSION'";
    backing.timeoutMs = 100;
    backing.label = "mutated-label";
    readyScriptedWorker(worker);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispatched = postedOfType(worker, "exec")[0] as {
      job: { jobId: string; code: string; label?: string };
    };
    expect(dispatched.job).toEqual({
      jobId: "job-snapshotted",
      code: "'safe'",
      label: "safe-label",
    });
    expect(reads).toEqual({ jobId: 1, code: 1, timeoutMs: 1, label: 1 });

    worker.emit({
      type: "finished",
      jobId: "job-snapshotted",
      result: {
        jobId: "job-snapshotted", engine: "pyodide", outcome: "completed",
        valueJson: JSON.stringify("safe"), stdout: "", stderr: "", bridgeCalls: 0, wallMs: 1,
      } satisfies KernelJobResult,
    });
    await expect(pending).resolves.toMatchObject({
      jobId: "job-snapshotted",
      outcome: "completed",
      valueJson: JSON.stringify("safe"),
    });
  });

  it("admits synchronously so cancel can revoke a job during slow interpreter boot", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const pending = engine.exec({ code: "1", jobId: "job-cancel-during-boot" });

    expect(engine.cancel("job-cancel-during-boot", "cancel before ready")).toBe(true);
    await expect(pending).resolves.toMatchObject({
      outcome: "cancelled",
      error: "cancel before ready",
    });
    expect(postedOfType(worker, "exec")).toHaveLength(0);

    readyScriptedWorker(worker);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.describe().state).toBe("ready");
    await engine.terminate("test cleanup");
  });

  it("rejects a trusted frame carrying the wrong generation capability", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;
    const pending = engine.exec({ code: "1", jobId: "job-wrong-generation" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const init = postedOfType(worker, "init")[0] as {
      protocolToken: string;
      generation: number;
    };
    worker.emit({
      type: "finished",
      protocol: PYODIDE_KERNEL_PROTOCOL_VERSION,
      protocolToken: init.protocolToken,
      generation: init.generation + 1,
      jobId: "job-wrong-generation",
      result: {
        jobId: "job-wrong-generation", engine: "pyodide", outcome: "completed",
        valueJson: "1", stdout: "", stderr: "", bridgeCalls: 0, wallMs: 1,
      },
    }, { authenticate: false });

    await expect(pending).resolves.toMatchObject({
      outcome: "crashed",
      error: expect.stringContaining("generation capability"),
    });
    expect(worker.terminated).toBe(true);
  });

  it("rejects an untrusted MessageEvent even when its capability is exact", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;
    const pending = engine.exec({ code: "1", jobId: "job-untrusted-frame" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({
      type: "finished",
      jobId: "job-untrusted-frame",
      result: {
        jobId: "job-untrusted-frame", engine: "pyodide", outcome: "completed",
        valueJson: "1", stdout: "", stderr: "", bridgeCalls: 0, wallMs: 1,
      },
    }, { trusted: false });

    await expect(pending).resolves.toMatchObject({
      outcome: "crashed",
      error: expect.stringContaining("not delivered by the browser controller"),
    });
    expect(worker.terminated).toBe(true);
  });

  it("serializes jobs: the second exec frame is posted only after the first job finished", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const first = engine.exec({ code: "a = 1", jobId: "job-a" });
    const second = engine.exec({ code: "a + 1", jobId: "job-b" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(postedOfType(worker, "exec")).toHaveLength(1);
    expect((postedOfType(worker, "exec")[0] as { job: { jobId: string } }).job.jobId).toBe("job-a");
    expect(engine.describe().queuedJobs).toBe(2);

    worker.emit({
      type: "finished",
      jobId: "job-a",
      result: { jobId: "job-a", engine: "pyodide", outcome: "completed", valueJson: "null", stdout: "", stderr: "", bridgeCalls: 0, wallMs: 3 } satisfies KernelJobResult,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(postedOfType(worker, "exec")).toHaveLength(2);
    expect((postedOfType(worker, "exec")[1] as { job: { jobId: string } }).job.jobId).toBe("job-b");

    worker.emit({
      type: "finished",
      jobId: "job-b",
      result: { jobId: "job-b", engine: "pyodide", outcome: "completed", valueJson: "2", stdout: "", stderr: "", bridgeCalls: 0, wallMs: 2 } satisfies KernelJobResult,
    });
    expect((await first).outcome).toBe("completed");
    expect((await second).valueJson).toBe("2");
  });

  it("stamps bootMs onto exactly the first result of a generation", async () => {
    const worker = makeScriptedWorker();
    const events: KernelJobEvent[] = [];
    const { engine } = makeEngine(worker);
    engine.onEvent((event) => events.push(event));
    const boot = engine.start();
    readyScriptedWorker(worker, 512);
    await boot;

    const first = await engine.exec({ code: "1" });
    const second = await engine.exec({ code: "2" });
    expect(first.bootMs).toBe(512);
    expect(second.bootMs).toBeUndefined();
    expect(events.filter((event) => event.type === "completed")).toHaveLength(2);
  });

  it("routes bridge requests through the bridge port and answers back to the worker", async () => {
    const worker = makeScriptedWorker(false);
    const { engine, bridgeCalls } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    void engine.exec({ code: "await pat.call('read_file', json.dumps({}))", jobId: "job-bridge" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    worker.emit({ type: "bridge-request", jobId: "job-bridge", call: { jobId: "job-bridge", seq: 0, tool: "read_file", arguments: { path: "/x" } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].tool).toBe("read_file");
    expect(bridgeCalls[0].arguments).toEqual({ path: "/x" });
    const responses = postedOfType(worker, "bridge-response") as { jobId: string; call: KernelBridgeCallResult }[];
    expect(responses).toHaveLength(1);
    expect(responses[0].jobId).toBe("job-bridge");
    expect(responses[0].call).toEqual({ seq: 0, ok: true, content: "{}" });
  });

  it("registers and drains the exact bridge effect before re-entrant termination can publish", async () => {
    const worker = makeScriptedWorker(false);
    let effectAdmitted = false;
    let releaseEffect!: () => void;
    let stopping: Promise<void> | undefined;
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let engine!: PyodideKernelEngine;
    engine = new PyodideKernelEngine({
      ports: {
        workerFactory: () => worker,
        bridge: {
          call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
            effectAdmitted = true;
            // Re-enter before call() returns its Promise. The host must have
            // registered this effect already or termination can publish early.
            stopping = engine.terminate("terminate while host effect is admitted");
            await effectGate;
            return { seq: request.seq, ok: true, content: "{}" };
          },
        },
      },
    });
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;
    const pending = engine.exec({ code: "await pat.call(...) ", jobId: "job-drain-effect" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({
      type: "bridge-request",
      jobId: "job-drain-effect",
      call: { jobId: "job-drain-effect", seq: 0, tool: "slow_effect", arguments: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(effectAdmitted).toBe(true);

    let published = false;
    void pending.then(() => { published = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopping).toBeDefined();
    expect(worker.terminated).toBe(true);
    expect(published).toBe(false);
    expect(engine.describe().state).toBe("draining");

    releaseEffect();
    await stopping!;
    await expect(pending).resolves.toMatchObject({
      outcome: "crashed",
      bridgeCalls: 1,
      error: "terminate while host effect is admitted",
    });
    expect(engine.describe().state).toBe("stopped");
  });

  it("settles queued dependencies before an administrative bridge-task drain", async () => {
    const worker = makeScriptedWorker(false);
    let dependent: Promise<KernelJobResult> | undefined;
    let lateAdmission: Promise<KernelJobResult> | undefined;
    let engine!: PyodideKernelEngine;
    engine = new PyodideKernelEngine({
      ports: {
        workerFactory: () => worker,
        bridge: {
          call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
            dependent = engine.exec({ code: "2", jobId: "job-kill-dependent" });
            await dependent;
            // The kill is now draining this exact bridge task. A new recursive
            // admission must fail immediately rather than extend the cycle.
            lateAdmission = engine.exec({ code: "3", jobId: "job-kill-late" });
            await lateAdmission;
            return { seq: request.seq, ok: true, content: "{}" };
          },
        },
      },
    });
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const active = engine.exec({ code: "await pat.call(...) ", jobId: "job-kill-cycle" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({
      type: "bridge-request",
      jobId: "job-kill-cycle",
      call: { jobId: "job-kill-cycle", seq: 0, tool: "recursive_kernel", arguments: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dependent).toBeDefined();

    await engine.terminate("administrative dependency-cycle reset");
    await expect(dependent!).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(lateAdmission!).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("draining an admitted host bridge effect"),
    });
    await expect(active).resolves.toMatchObject({
      outcome: "crashed",
      error: "administrative dependency-cycle reset",
      bridgeCalls: 1,
    });
    expect(worker.terminated).toBe(true);
    expect(engine.describe().state).toBe("stopped");
  });

  it("breaks a bridge-to-queued-job dependency cycle before draining the active terminal result", async () => {
    const worker = makeScriptedWorker(false);
    let dependent: Promise<KernelJobResult> | undefined;
    let bridgeReturned = false;
    let engine!: PyodideKernelEngine;
    engine = new PyodideKernelEngine({
      ports: {
        workerFactory: () => worker,
        bridge: {
          call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
            dependent = engine.exec({ code: "2", jobId: "job-dependent-on-active" });
            await dependent;
            bridgeReturned = true;
            return { seq: request.seq, ok: true, content: "{}" };
          },
        },
      },
    });
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const active = engine.exec({ code: "void pat.call(...); 1", jobId: "job-active-cycle" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({
      type: "bridge-request",
      jobId: "job-active-cycle",
      call: { jobId: "job-active-cycle", seq: 0, tool: "recursive_kernel", arguments: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dependent).toBeDefined();

    worker.emit({
      type: "finished",
      jobId: "job-active-cycle",
      result: {
        jobId: "job-active-cycle", engine: "pyodide", outcome: "completed",
        valueJson: "1", stdout: "", stderr: "", bridgeCalls: 1, wallMs: 2,
      } satisfies KernelJobResult,
    });

    await expect(dependent!).resolves.toMatchObject({
      outcome: "cancelled",
      error: expect.stringContaining("dependency cycle"),
    });
    await expect(active).resolves.toMatchObject({ outcome: "completed", valueJson: "1" });
    expect(bridgeReturned).toBe(true);
    expect(postedOfType(worker, "bridge-response")).toHaveLength(0);
    expect(worker.terminated).toBe(false);
    expect(engine.describe().state).toBe("ready");
    await engine.terminate("dependency-cycle test cleanup");
  });

  it("cancel resolves a queued job as cancelled without touching the worker", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    void engine.exec({ code: "busy", jobId: "job-busy" });
    const queued = engine.exec({ code: "later", jobId: "job-queued" });
    expect(engine.cancel("job-queued", "policy cancel")).toBe(true);
    const result = await queued;
    expect(result.outcome).toBe("cancelled");
    expect(result.error).toContain("policy cancel");
    expect(postedOfType(worker, "cancel")).toHaveLength(0);
    expect(worker.terminated).toBe(false);
    await engine.terminate("lane cleanup");
  });

  it("cancel of the active job posts the cooperative cancel frame and does NOT terminate when the job settles in grace", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const job = engine.exec({ code: "await pat.sleep(60000)", jobId: "job-sleep" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(engine.cancel("job-sleep", "user asked")).toBe(true);
    const cancels = postedOfType(worker, "cancel") as { jobId: string; reason?: string }[];
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ type: "cancel", jobId: "job-sleep", reason: "user asked" });

    // The worker answers inside the grace window with its own boundary report.
    worker.emit({
      type: "finished",
      jobId: "job-sleep",
      result: {
        jobId: "job-sleep", engine: "pyodide", outcome: "cancelled",
        error: `${PYODIDE_CANCELLED_AT_BOUNDARY}: user asked. CPython cannot interrupt a statement in flight.`,
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 20,
      } satisfies KernelJobResult,
    });
    const result = await job;
    expect(result.outcome).toBe("cancelled");
    expect(result.error).toContain(PYODIDE_CANCELLED_AT_BOUNDARY);
    // Cooperative success: the worker survives, no terminate, state ready again.
    await new Promise((resolve) => setTimeout(resolve, PYODIDE_TERMINATE_GRACE_MS + 100));
    expect(worker.terminated).toBe(false);
    expect(engine.describe().state).toBe("ready");
    expect(engine.describe().generation).toBe(0);
  });

  it("keeps host cancellation authoritative when a worker later claims completed", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const pending = engine.exec({ code: "1", jobId: "job-suppressed-cancel" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.cancel("job-suppressed-cancel", "host policy cancelled")).toBe(true);
    worker.emit({
      type: "finished",
      jobId: "job-suppressed-cancel",
      result: {
        jobId: "job-suppressed-cancel", engine: "pyodide", outcome: "completed",
        valueJson: "1", stdout: "", stderr: "", bridgeCalls: 0, wallMs: 1,
      },
    });

    const result = await pending;
    expect(result).toMatchObject({
      outcome: "cancelled",
      error: expect.stringContaining("host authority"),
    });
    expect(result.valueJson).toBeUndefined();
    expect(worker.terminated).toBe(false);
    await engine.terminate("test cleanup");
  });

  it("keeps a cancellation accepted during bridge drain authoritative at publication", async () => {
    const worker = makeScriptedWorker(false);
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const engine = new PyodideKernelEngine({
      ports: {
        workerFactory: () => worker,
        bridge: {
          call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
            await effectGate;
            return { seq: request.seq, ok: true, content: "{}" };
          },
        },
      },
    });
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const pending = engine.exec({ code: "void pat.call(...); 1", jobId: "job-cancel-during-drain" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({
      type: "bridge-request",
      jobId: "job-cancel-during-drain",
      call: { jobId: "job-cancel-during-drain", seq: 0, tool: "slow_effect", arguments: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit({
      type: "finished",
      jobId: "job-cancel-during-drain",
      result: {
        jobId: "job-cancel-during-drain", engine: "pyodide", outcome: "completed",
        valueJson: "1", stdout: "", stderr: "", bridgeCalls: 1, wallMs: 2,
      } satisfies KernelJobResult,
    });
    expect(engine.describe().state).toBe("draining");
    expect(engine.cancel("job-cancel-during-drain", "host cancelled during drain")).toBe(true);

    releaseEffect();
    const result = await pending;
    expect(result).toMatchObject({
      outcome: "cancelled",
      error: expect.stringContaining("host authority"),
      bridgeCalls: 1,
    });
    expect(result.valueJson).toBeUndefined();
    expect(worker.terminated).toBe(false);
    await engine.terminate("cancel-during-drain test cleanup");
  });

  it("escalates to worker termination after PYODIDE_TERMINATE_GRACE_MS and names the namespace reset", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const active = engine.exec({ code: "while True:\n    pass", jobId: "job-loop" });
    const queued = engine.exec({ code: "never", jobId: "job-never" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    expect(engine.cancel("job-loop", "stuck loop")).toBe(true);

    const result = await active;
    const queuedResult = await queued;
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain(`${PYODIDE_TERMINATE_GRACE_MS} ms`);
    expect(result.error).toContain("namespace was reset");
    expect(queuedResult.outcome).toBe("cancelled");
    expect(queuedResult.error).toContain("namespace was reset");
    expect(worker.terminated).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PYODIDE_TERMINATE_GRACE_MS - 100);
    expect(engine.describe().state).toBe("failed");
    expect(engine.describe().generation).toBe(1);
  });

  it("the wall-clock budget escalates through the same cooperative-first ladder", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker, { maxJobWallMs: 60 });
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const result = await engine.exec({ code: "while True:\n    pass", jobId: "job-wall" });
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain("wall-clock budget");
    const cancels = postedOfType(worker, "cancel") as { jobId: string; reason?: string }[];
    expect(cancels).toHaveLength(1);
    expect(cancels[0].reason).toContain("wall-clock budget (60 ms)");
    expect(worker.terminated).toBe(true);
  });

  it("terminate crashes the active job, cancels queued jobs, and lands on stopped", async () => {
    const worker = makeScriptedWorker(false);
    const { engine } = makeEngine(worker);
    const boot = engine.start();
    readyScriptedWorker(worker);
    await boot;

    const active = engine.exec({ code: "long", jobId: "job-long" });
    const queued = engine.exec({ code: "queued", jobId: "job-queued" });
    await engine.terminate("policy replacement");
    const activeResult = await active;
    const queuedResult = await queued;
    expect(activeResult.outcome).toBe("crashed");
    expect(activeResult.error).toContain("policy replacement");
    expect(queuedResult.outcome).toBe("cancelled");
    expect(engine.describe().state).toBe("stopped");
    expect(worker.terminated).toBe(true);
  });

  it("restart respawns the worker, resets the namespace report, and stamps the new generation boot", async () => {
    const workers: ScriptedWorker[] = [];
    const bridgeCalls: KernelBridgeCallRequest[] = [];
    const engine = new PyodideKernelEngine({
      ports: {
        bridge: {
          call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
            bridgeCalls.push(request);
            return { seq: request.seq, ok: true, content: "{}" };
          },
        },
        workerFactory: () => {
          const worker = makeScriptedWorker();
          workers.push(worker);
          return worker;
        },
      },
    });

    const boot = engine.start();
    readyScriptedWorker(workers[0], 100);
    await boot;
    const first = await engine.exec({ code: "x = 1" });
    expect(first.bootMs).toBe(100);

    const restarting = engine.restart();
    // restart() awaits killWorker before the new boot runs the factory; one
    // tick puts the second worker into `workers` deterministically.
    await new Promise((resolve) => setTimeout(resolve, 0));
    readyScriptedWorker(workers[1], 200);
    await restarting;

    expect(engine.describe().generation).toBe(1);
    expect(engine.describe().bootMs).toBe(200);
    expect(workers[0].terminated).toBe(true);
    const second = await engine.exec({ code: "x + 1" });
    expect(second.bootMs).toBe(200);
    const third = await engine.exec({ code: "3" });
    expect(third.bootMs).toBeUndefined();
  });

  it("emits the canonical fail-closed ambient/controller scrub before namespace work", () => {
    const source = pyodideKernelWorkerSource(DEFAULT_KERNEL_BUDGETS, "/execution-packs/pyodide/");
    for (const name of [
      ...DISPOSABLE_WORKER_AMBIENT_GLOBALS,
      ...DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
      ...DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
    ]) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source).toMatch(/^"use strict";\n\(\(\) => \{/u);
    expect(source.trimEnd()).toMatch(/\}\)\(\);\n\}\)\(\);$/u);
    expect(source).toContain('if (!event || event.isTrusted !== true) return;');
    expect(source).toContain('__listen("message", __onControllerMessage);');
    expect(source).not.toContain("globalThis.onmessage =");
    expect(source).toContain("if (this === __controllerGlobal)");
    expect(source).toContain("return __reflectApply(nativeMethod, this, args)");

    const loaded = source.indexOf("__py = await module.loadPyodide");
    const ambient = source.indexOf("__scrubAmbient();", loaded);
    const controller = source.indexOf("__scrubController();", ambient);
    const stdout = source.indexOf("__py.setStdout", controller);
    const globals = source.indexOf("__globals = __py.toPy", controller);
    const register = source.indexOf('registerJsModule("pat"', controller);
    const namespace = source.indexOf("<prime-kernel-init>", controller);
    const ready = source.indexOf('type: "ready"', controller);
    expect(loaded).toBeGreaterThan(-1);
    expect(ambient).toBeGreaterThan(loaded);
    expect(controller).toBeGreaterThan(ambient);
    expect(Math.min(stdout, globals, register, namespace, ready)).toBeGreaterThan(controller);

    expect(source).not.toContain("loadPackagesFromImports");
    expect(source).toContain(PAT_KERNEL_VERSION);
    expect(source).toContain(PYODIDE_CANCELLED_AT_BOUNDARY);
    expect(source).toContain(PYODIDE_KERNEL_PROTOCOL_VERSION);
    expect(() => new Function(source)).not.toThrow();
  });

  it("keeps persistent controller state on captured natives rather than guest-poisonable prototypes", () => {
    const source = pyodideKernelWorkerSource(DEFAULT_KERNEL_BUDGETS, "/execution-packs/pyodide/");
    for (const binding of [
      "__mapGet", "__mapSet", "__mapDelete", "__mapValues", "__mapClear", "__mapIteratorNext",
      "__jsonParse", "__jsonStringify", "__encode", "__String", "__Error",
      "__now", "__setTimeout", "__max", "__min",
    ]) {
      expect(source).toContain(`const ${binding} =`);
    }
    expect(source).toContain('__setData(job, "pending", new __Map())');
    expect(source).toContain("__mapGet(job.pending, seq)");
    expect(source).toContain("__mapSet(job.pending, seq");
    expect(source).toContain("__mapClear(job.pending)");
    expect(source).toContain("__runPythonAsync = __py.runPythonAsync.bind(__py)");
  });

  it("keeps the direct research class but quarantines factory activation", () => {
    const ports = {
      bridge: { call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => ({ seq: request.seq, ok: true, content: "{}" }) },
      workerFactory: () => makeScriptedWorker(),
    };
    const js = createKernelEngine("javascript", { ports });
    expect(js).toBeInstanceOf(PrimeKernelHost);
    expect(js.describe().engine).toBe("javascript");
    expect(js.describe().cancellation).toBe("abort-signal-then-terminate-worker");

    let quarantine: unknown;
    try {
      createKernelEngine("pyodide", { ports });
    } catch (error) {
      quarantine = error;
    }
    expect(quarantine).toBeInstanceOf(PyodideEngineQuarantinedError);
    expect((quarantine as Error).name).toBe("PyodideEngineQuarantinedError");
    expect((quarantine as Error).message).toBe(PYODIDE_ENGINE_QUARANTINE_MESSAGE);
    expect((quarantine as Error).message).toMatch(/(?:quarantined.*asyncio|asyncio.*quarantined)/iu);

    const selectorSource = readFileSync(new URL("./engines.ts", import.meta.url), "utf8");
    expect(selectorSource).not.toMatch(/from\s+["']\.\/pyodide-engine["']/u);
    expect(PYODIDE_ASSET_PATH).toBe(`${import.meta.env.BASE_URL}execution-packs/pyodide/`);
    expect(pyodideAssetPathForBase("/airship/")).toBe("/airship/execution-packs/pyodide/");
    expect(() => pyodideAssetPathForBase("//attacker.example/")).toThrow(/pinned absolute URL path/u);
    expect(() => pyodideAssetPathForBase("/airship/../escape/")).toThrow(/pinned absolute URL path/u);
  });
});

/* ------------------------------------------------------------------ */
/* Lane 2: live pinned pack (PRIME_PYODIDE_LIVE=1, off by default)     */
/* ------------------------------------------------------------------ */

const LIVE = process.env.PRIME_PYODIDE_LIVE === "1";
/** node_modules/pyodide as a filesystem path with trailing separator; the worker concatenates onto it. */
const PYODIDE_PACK_DIR = fileURLToPath(new URL("../../../node_modules/pyodide/", import.meta.url));

/*
 * node:worker_threads seam for the live lane: the worker speaks the exact
 * browser-shaped protocol (lexical trusted message listener / sender) against
 * parentPort, and imports the pinned pack from the local filesystem. No
 * network is touched: the pack lives at node_modules/pyodide and pyodide
 * resolves it through its node loader.
 */
const NODE_WORKER_SHIM = `
const { parentPort } = require("node:worker_threads");
(() => {
  const listeners = [];
  globalThis.addEventListener = (type, listener) => { if (type === "message") listeners.push(listener); };
  globalThis.removeEventListener = (type, listener) => {
    if (type !== "message") return;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
  globalThis.dispatchEvent = () => false;
  globalThis.postMessage = (message) => parentPort.postMessage(message);
  parentPort.on("message", (message) => {
    for (const listener of [...listeners]) listener({ data: message, isTrusted: true });
  });
})();
`;

function adaptNodeWorker(worker: NodeWorker): KernelWorkerLike {
  const wrapped = new Map<object, (raw: unknown) => void>();
  return {
    postMessage(message: unknown) {
      worker.postMessage(message);
    },
    terminate() {
      void worker.terminate();
    },
    addEventListener(type: "message" | "error", listener: (event: never) => void) {
      const fn = (raw: unknown): void => {
        if (type === "message") (listener as (event: { data?: unknown; isTrusted: true }) => void)({ data: raw, isTrusted: true });
        else (listener as (event: { message?: string }) => void)({ message: raw instanceof Error ? raw.message : String(raw) });
      };
      wrapped.set(listener as unknown as object, fn);
      worker.on(type, fn);
    },
    removeEventListener(type: "message" | "error", listener: (event: never) => void) {
      const fn = wrapped.get(listener as unknown as object);
      if (!fn) return;
      wrapped.delete(listener as unknown as object);
      worker.off(type, fn);
    },
  };
}

function liveWorkerFactory(budgets: KernelBudgets): () => KernelWorkerLike {
  return () => adaptNodeWorker(new NodeWorker(`${NODE_WORKER_SHIM}\n${pyodideKernelWorkerSource(budgets, PYODIDE_PACK_DIR)}`, { eval: true }));
}

function makeLiveEngine(budgets?: Partial<KernelBudgets>): { engine: PyodideKernelEngine; bridgeCalls: KernelBridgeCallRequest[] } {
  const mergedBudgets: KernelBudgets = { ...DEFAULT_KERNEL_BUDGETS, ...budgets };
  const bridgeCalls: KernelBridgeCallRequest[] = [];
  const engine = new PyodideKernelEngine({
    budgets,
    ports: {
      bridge: {
        call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => {
          bridgeCalls.push(request);
          return { seq: request.seq, ok: true, content: JSON.stringify({ echo: request.arguments, tool: request.tool }) };
        },
      },
      workerFactory: liveWorkerFactory(mergedBudgets),
    },
  });
  return { engine, bridgeCalls };
}

const BOOT_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 60_000;

describe.skipIf(!LIVE)("PyodideKernelEngine (live pinned pack)", () => {
  it("pinned pyodide pack parity: node_modules matches the engine pin (served bytes gate)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../node_modules/pyodide/package.json", import.meta.url), "utf8")) as { version?: unknown };
    expect(manifest.version).toBe(PYODIDE_VERSION);
  });

  it("boots ready with bootMs and the pinned runtime version", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const capability = engine.describe();
      expect(capability.state).toBe("ready");
      expect(capability.bootMs).toBeGreaterThan(0);
      expect(capability.runtimeVersion).toBe(PYODIDE_VERSION);
      expect(capability.network).toBe("absent-ambient; tool bridge only");
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("keeps the namespace across two jobs and stamps bootMs once", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const first = await engine.exec({ code: "x = 1" });
      expect(first.outcome).toBe("completed");
      expect(first.bootMs).toBeGreaterThan(0);
      const second = await engine.exec({ code: "x + 1" });
      expect(second.outcome).toBe("completed");
      expect(second.valueJson).toBe("2");
      expect(second.bootMs).toBeUndefined();
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("pat.call round-trips JSON text through the host bridge mid-await", async () => {
    const { engine, bridgeCalls } = makeLiveEngine();
    try {
      await engine.start();
      const result = await engine.exec({ code: "import json\nreply = await pat.call('echo_tool', json.dumps({'k': 1}))\nreply" });
      expect(result.outcome).toBe("completed");
      expect(bridgeCalls).toHaveLength(1);
      expect(bridgeCalls[0].tool).toBe("echo_tool");
      expect(bridgeCalls[0].arguments).toEqual({ k: 1 });
      expect(JSON.parse(JSON.parse(result.valueJson!))).toEqual({ echo: { k: 1 }, tool: "echo_tool" });
      expect(result.bridgeCalls).toBe(1);
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("streams stdout lines live and captures them into the bounded result", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const streamed: string[] = [];
      const result = await engine.exec({ code: "print('line-one')\nprint('line-two')\n'done'" }, (event) => {
        if (event.type === "stdout") streamed.push(event.text);
      });
      expect(result.outcome).toBe("completed");
      expect(result.valueJson).toBe("\"done\"");
      expect(streamed.join("")).toContain("line-one");
      expect(streamed.join("")).toContain("line-two");
      expect(result.stdout).toContain("line-one");
      expect(result.stdout).toContain("line-two");
      expect(result.stderr).toBe("");
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("reports errors in the jupyter shape: ename/evalue/traceback tail", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const result = await engine.exec({ code: "1/0" });
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("ZeroDivisionError");
      expect(result.error).toContain("division by zero");
      expect(result.error).toContain("<prime-kernel>");
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("preloads the pat surface: _pat_version, pat.progress, pat.sleep are ambient", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const result = await engine.exec({
        code: "import pat\npat.progress('hello-progress')\nawait pat.sleep(30)\n_pat_version",
      });
      expect(result.outcome).toBe("completed");
      expect(result.valueJson).toBe(`\"${PAT_KERNEL_VERSION}\"`);
      expect(result.stdout).toContain(":: progress: hello-progress");
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("cancel lands at a statement boundary and the namespace survives (cooperative, not a kill)", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const setup = await engine.exec({ code: "boundary_marker = 41" });
      expect(setup.outcome).toBe("completed");

      const events: KernelJobEvent[] = [];
      const job = engine.exec({ code: "import pat\nawait pat.sleep(30000)\n'unreached'", jobId: "job-boundary" }, (event) => events.push(event));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(engine.cancel("job-boundary", "boundary test")).toBe(true);
      const result = await job;
      expect(result.outcome).toBe("cancelled");
      expect(result.error).toContain(`${PYODIDE_CANCELLED_AT_BOUNDARY}:`);
      expect(result.wallMs).toBeLessThan(10_000);
      expect(engine.describe().generation).toBe(0);

      // The same worker lives on; a cooperative cancel is not an interrupt
      // and is definitely not a kill — the namespace is intact.
      const followup = await engine.exec({ code: "boundary_marker + 1" });
      expect(followup.outcome).toBe("completed");
      expect(followup.valueJson).toBe("42");
      expect(events.map((event) => event.type)).toEqual(["started", "cancelled"]);
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("a pure-Python busy loop outlives the grace window and is terminated (honest crash)", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const started = Date.now();
      const job = engine.exec({ code: "while True:\n    pass", jobId: "job-busy-loop" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(engine.cancel("job-busy-loop", "unstick")).toBe(true);
      const result = await job;
      expect(result.outcome).toBe("crashed");
      expect(result.error).toContain(`${PYODIDE_TERMINATE_GRACE_MS} ms`);
      expect(result.error).toContain("namespace was reset");
      expect(Date.now() - started).toBeGreaterThanOrEqual(PYODIDE_TERMINATE_GRACE_MS);
      expect(engine.describe().state).toBe("failed");
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS + 10_000);

  it("restart resets the namespace — the reset is stated, not hidden", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const first = await engine.exec({ code: "restart_marker = 42" });
      expect(first.outcome).toBe("completed");
      const generationBefore = engine.describe().generation;

      await engine.restart();
      expect(engine.describe().generation).toBeGreaterThan(generationBefore);
      expect(engine.describe().state).toBe("ready");
      expect(engine.describe().bootMs).toBeGreaterThan(0);

      const after = await engine.exec({ code: "restart_marker + 1" });
      expect(after.outcome).toBe("failed");
      expect(after.error).toContain("NameError");
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS * 2);

  it("caps the serialized value with the named truncation marker", async () => {
    const { engine } = makeLiveEngine({ maxValueBytes: 64 });
    try {
      await engine.start();
      const result = await engine.exec({ code: "'y' * 500" });
      expect(result.outcome).toBe("completed");
      expect(JSON.parse(result.valueJson!)).toEqual({ primeValue: "truncated", limitBytes: 64 });
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("rejects oversized bridge payloads inside the job, with the budget named", async () => {
    const { engine, bridgeCalls } = makeLiveEngine({ maxBridgePayloadBytes: 64 });
    try {
      await engine.start();
      const result = await engine.exec({ code: "import json\nawait pat.call('echo_tool', json.dumps({'k': 'y' * 500}))" });
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("bridge payload budget");
      expect(bridgeCalls).toHaveLength(0);
    } finally {
      await engine.terminate();
    }
  }, BOOT_TIMEOUT_MS);

  it("removes every canonical ambient/controller owner from the worker prototype chain", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const names = [
        ...DISPOSABLE_WORKER_AMBIENT_GLOBALS,
        ...DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
        ...DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
      ];
      const result = await engine.exec({
        code: `import js
names = ${JSON.stringify([
          ...DISPOSABLE_WORKER_AMBIENT_GLOBALS,
          ...DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
          ...DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
        ])}
exposed = []
for name in names:
    cursor = js.globalThis
    while cursor:
        descriptor = js.Object.getOwnPropertyDescriptor(cursor, name)
        if descriptor and (js.Reflect.get(descriptor, "value") is not None or js.Reflect.get(descriptor, "get") is not None or js.Reflect.get(descriptor, "set") is not None):
            exposed.append(name)
            break
        cursor = js.Object.getPrototypeOf(cursor)
exposed`,
      });
      expect(result.outcome, result.error).toBe("completed");
      expect(names.length).toBeGreaterThan(0);
      expect(JSON.parse(result.valueJson!)).toEqual([]);
    } finally {
      await engine.terminate();
    }
  }, JOB_TIMEOUT_MS + BOOT_TIMEOUT_MS);

  it("keeps local EventTarget behavior while the worker controller stays hidden", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const result = await engine.exec({
        code: `import js
from pyodide.ffi import create_proxy
seen = []
def record(event):
    seen.append(str(event.type))
callback = create_proxy(record)
controller = js.AbortController.new()
controller.signal.addEventListener("abort", callback)
controller.abort()
answer = (seen, js.globalThis.addEventListener is None, js.globalThis.postMessage is None)
callback.destroy()
answer`,
      });
      expect(result.outcome).toBe("completed");
      expect(JSON.parse(result.valueJson!)).toEqual([["abort"], true, true]);
    } finally {
      await engine.terminate();
    }
  }, JOB_TIMEOUT_MS + BOOT_TIMEOUT_MS);
});
