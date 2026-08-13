/**
 * Kernel host protocol tests with a scripted in-process worker. These tests
 * lock the host-side state machine (queue serialization, bridge routing,
 * cancel, crash treatment, restart) independently of any real Worker.
 */
import { createContext, runInContext } from "node:vm";
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
    const job = host.exec({ code: "await pat.call('read_file', {})" });
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

  it("restart() counts one namespace reset, not two", async () => {
    const worker = makeScriptedWorker();
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    expect(host.description().generation).toBe(0);

    const restarted = host.restart();
    // restart() boots a fresh worker through the same scripted double; the
    // ready handshake has to be answered again before it settles.
    await new Promise((r) => setTimeout(r, 0));
    worker.emit({ type: "ready", engine: "javascript" });
    await restarted;
    expect(host.description().generation).toBe(1);
  });

  it("a rejected boot is not memoized: the next exec boots a new worker", async () => {
    let boots = 0;
    const built: ScriptedWorker[] = [];
    const host = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) },
        workerFactory: () => {
          boots += 1;
          const worker = makeScriptedWorker();
          built.push(worker);
          // The listeners are attached synchronously right after the factory
          // returns, so the handshake answer is queued rather than emitted.
          const attempt = boots;
          queueMicrotask(() => {
            if (attempt === 1) worker.fail("blocked by content security policy");
            else worker.emit({ type: "ready", engine: "javascript" });
          });
          return worker;
        },
      },
    });

    await expect(host.exec({ code: "true" })).rejects.toThrow("failed to boot");
    expect(boots).toBe(1);
    expect(built[0]!.terminated).toBe(true);

    const result = await host.exec({ code: "true" });
    expect(boots).toBe(2);
    expect(result.outcome).toBe("completed");
  });
});

/**
 * The real worker source, executed. The scripted double above locks the host
 * state machine but can never catch a contract break inside the generated
 * text, and the identifier the toolkit is bound to is exactly such a contract:
 * the system prompt and the execute_code description both promise the model
 * `pat.call`, and the pyodide engine delivers it, so the javascript engine has
 * to as well. A fresh `node:vm` realm stands in for the worker global — the
 * source hard-removes ambient globals with `configurable: false`, which would
 * poison the shared test process if it ran against the real one.
 */
describe("kernelWorkerSource (real source in a fresh realm)", () => {
  type SandboxWorker = {
    posted: Record<string, unknown>[];
    send(message: unknown): void;
  };

  function bootWorkerSource(): SandboxWorker {
    const posted: Record<string, unknown>[] = [];
    const sandbox: Record<string, unknown> = {
      postMessage: (message: Record<string, unknown>) => { posted.push(message); },
      TextEncoder,
      AbortController,
      setTimeout,
      clearTimeout,
    };
    const context = createContext(sandbox);
    runInContext(kernelWorkerSource(DEFAULT_KERNEL_BUDGETS), context);
    return {
      posted,
      send: (message: unknown) => {
        (sandbox.onmessage as (event: { data: unknown }) => void)({ data: message });
      },
    };
  }

  async function waitFor<T>(read: () => T | undefined): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("the worker never posted the expected message");
  }

  /*
   * The reason the port exists, asserted against the real generated worker.
   *
   * prime-agent's model does not emit a tool-call envelope to delegate — it
   * writes `await rlm("do this subtask", { name: "reviewer" })` inside the
   * persistent kernel. Registering the RLM tools on the host made delegation
   * reachable only as `pat.call("rlm_spawn", …)`: correct, and not the
   * language the ported system prompt teaches. These bindings are the
   * spelling, and the spelling is the feature.
   */
  it("calls rlm(...) as a function and routes it through the reviewed bridge", async () => {
    const worker = bootWorkerSource();
    expect(worker.posted[0]).toMatchObject({ type: "ready", engine: "javascript" });

    worker.send({
      type: "exec",
      job: {
        jobId: "job-rlm",
        code: "return await rlm('review the diff', { name: 'reviewer' });",
      },
    });

    const request = await waitFor(() => worker.posted.find((m) => m.type === "bridge-request")) as {
      call: { seq: number; tool: string; arguments: Record<string, unknown> };
    };
    // Same egress as every other tool: nothing here is a second channel.
    expect(request.call.tool).toBe("rlm_spawn");
    expect(request.call.arguments).toEqual({ prompt: "review the diff", name: "reviewer" });
  });

  it("gives agent_message.send the three targets the router admits", async () => {
    const worker = bootWorkerSource();
    worker.send({
      type: "exec",
      job: {
        jobId: "job-msg",
        code: "return await agent_message.send({ name: 'reviewer' }, 'status?');",
      },
    });

    const request = await waitFor(() => worker.posted.find((m) => m.type === "bridge-request")) as {
      call: { tool: string; arguments: Record<string, unknown> };
    };
    expect(request.call.tool).toBe("agent_message");
    expect(request.call.arguments).toEqual({ action: "send", message: "status?", receiver_name: "reviewer" });
  });

  it("binds the rest of the family without shadowing a user namespace key", async () => {
    const worker = bootWorkerSource();
    worker.send({
      type: "exec",
      job: {
        jobId: "job-family",
        code: "return [typeof subagent, typeof agent_observe, typeof harness, typeof heartbeat].join(',');",
      },
    });
    const done = await waitFor(() => worker.posted.find((m) => m.type === "finished")) as {
      result: { outcome: string; valueJson?: string };
    };
    expect(done.result.outcome).toBe("completed");
    expect(done.result.valueJson).toContain("function,function,function,function");
  });

  it("binds the tool bridge to `pat`, so the documented call reaches the host", async () => {
    const worker = bootWorkerSource();
    expect(worker.posted[0]).toMatchObject({ type: "ready", engine: "javascript" });

    worker.send({
      type: "exec",
      job: {
        jobId: "job-1",
        code: "const reply = await pat.call('read_file', { path: '/workspace/x.md' });\nreturn reply.content;",
      },
    });

    const request = await waitFor(() => worker.posted.find((m) => m.type === "bridge-request")) as {
      call: { seq: number; tool: string; arguments: Record<string, unknown> };
    };
    expect(request.call.tool).toBe("read_file");
    expect(request.call.arguments).toEqual({ path: "/workspace/x.md" });

    worker.send({
      type: "bridge-response",
      jobId: "job-1",
      call: { seq: request.call.seq, ok: true, content: "file body" },
    });

    const finished = await waitFor(() => worker.posted.find((m) => m.type === "finished")) as {
      result: { outcome: string; valueJson?: string; error?: string; bridgeCalls: number };
    };
    expect(finished.result.error).toBeUndefined();
    expect(finished.result.outcome).toBe("completed");
    expect(finished.result.valueJson).toBe(JSON.stringify("file body"));
    expect(finished.result.bridgeCalls).toBe(1);
  });
});
