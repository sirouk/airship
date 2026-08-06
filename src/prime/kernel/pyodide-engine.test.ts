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
import { DEFAULT_KERNEL_BUDGETS } from "./kernel-contract";
import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelBudgets,
  KernelJobEvent,
  KernelJobResult,
} from "./kernel-contract";
import type { KernelWorkerLike } from "./kernel-host";
import { PrimeKernelHost } from "./kernel-host";
import { createKernelEngine } from "./engines";
import {
  PAT_KERNEL_VERSION,
  PYODIDE_CANCELLED_AT_BOUNDARY,
  pyodideKernelWorkerSource,
} from "./pyodide-worker-source";
import {
  PYODIDE_ASSET_PATH,
  PYODIDE_TERMINATE_GRACE_MS,
  PYODIDE_VERSION,
  PyodideKernelEngine,
} from "./pyodide-engine";

/* ------------------------------------------------------------------ */
/* Lane 1: scripted in-process worker                                  */
/* ------------------------------------------------------------------ */

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
      const data = message as { type?: string; job?: { jobId: string; code: string; label?: string } };
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
    expect(cancels[0]).toEqual({ type: "cancel", jobId: "job-sleep", reason: "user asked" });

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

    expect(engine.describe().generation).toBe(2);
    expect(engine.describe().bootMs).toBe(200);
    expect(workers[0].terminated).toBe(true);
    const second = await engine.exec({ code: "x + 1" });
    expect(second.bootMs).toBe(200);
    const third = await engine.exec({ code: "3" });
    expect(third.bootMs).toBeUndefined();
  });

  it("pyodide worker source keeps the exact ambient removal list and never loads packages", () => {
    const source = pyodideKernelWorkerSource(DEFAULT_KERNEL_BUDGETS, "/execution-packs/pyodide/");
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source).not.toContain("loadPackagesFromImports");
    expect(source).toContain('registerJsModule("pat"');
    expect(source).toContain(PAT_KERNEL_VERSION);
    expect(source).toContain(PYODIDE_CANCELLED_AT_BOUNDARY);
    // The generated runtime must parse as a classic script body.
    expect(() => new Function(source)).not.toThrow();
  });

  it("createKernelEngine routes kinds to the two engine classes", () => {
    const ports = {
      bridge: { call: async (request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> => ({ seq: request.seq, ok: true, content: "{}" }) },
      workerFactory: () => makeScriptedWorker(),
    };
    const js = createKernelEngine("javascript", { ports });
    const py = createKernelEngine("pyodide", { ports });
    expect(js).toBeInstanceOf(PrimeKernelHost);
    expect(py).toBeInstanceOf(PyodideKernelEngine);
    expect(js.describe().engine).toBe("javascript");
    expect(js.describe().cancellation).toBe("abort-signal-then-terminate-worker");
    expect(py.describe().engine).toBe("pyodide");
    expect(py.describe().version).toBe(PYODIDE_VERSION);
    expect(PYODIDE_ASSET_PATH).toBe("/execution-packs/pyodide/");
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
 * browser-shaped protocol (globalThis.onmessage / postMessage) against
 * parentPort, and imports the pinned pack from the local filesystem. No
 * network is touched: the pack lives at node_modules/pyodide and pyodide
 * resolves it through its node loader.
 */
const NODE_WORKER_SHIM = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (message) => { if (typeof globalThis.onmessage === "function") globalThis.onmessage({ data: message }); });
globalThis.postMessage = (message) => parentPort.postMessage(message);
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
        if (type === "message") (listener as (event: { data?: unknown }) => void)({ data: raw });
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

  it("refuses the ambient network surface after boot (removals applied)", async () => {
    const { engine } = makeLiveEngine();
    try {
      await engine.start();
      const result = await engine.exec({ code: "import js\n(js.fetch is None, js.WebSocket is None)" });
      expect(result.outcome).toBe("completed");
      // The conversion of a python tuple lands as a JSON array of booleans.
      expect(JSON.parse(result.valueJson!)).toEqual([true, true]);
    } finally {
      await engine.terminate();
    }
  }, JOB_TIMEOUT_MS + BOOT_TIMEOUT_MS);
});
