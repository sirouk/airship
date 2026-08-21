/**
 * Kernel host protocol tests with a scripted in-process worker. These tests
 * lock the host-side state machine (queue serialization, bridge routing,
 * cancel, crash treatment, restart) independently of any real Worker.
 */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DISPOSABLE_WORKER_AMBIENT_GLOBALS } from "../../execution/disposable-worker-isolation-source";
import {
  DEFAULT_KERNEL_BUDGETS,
  MAX_KERNEL_STREAM_FRAMES,
} from "./kernel-contract";
import type {
  KernelBridgeCallRequest,
  KernelBridgeCallResult,
  KernelBudgets,
  KernelJobEvent,
  KernelJobResult,
} from "./kernel-contract";
import { kernelWorkerSource } from "./kernel-worker-source";
import type { KernelWorkerLike } from "./kernel-host";
import {
  PRIME_KERNEL_CANCEL_GRACE_MS,
  PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
  PrimeKernelHost,
} from "./kernel-host";

const AMBIENT_CHANNEL_NAMES = DISPOSABLE_WORKER_AMBIENT_GLOBALS;

type ScriptedWorker = KernelWorkerLike & {
  listeners: { message: ((event: { data?: unknown; isTrusted?: boolean }) => void)[]; error: ((event: { message?: string }) => void)[] };
  /** Emit a normal controller frame, authenticated with the factory capability. */
  emit(message: unknown): void;
  /** Bypass the helper to inject an adversarial wire value exactly as supplied. */
  emitRaw(message: unknown): void;
  fail(message: string): void;
  posted: unknown[];
  terminated: boolean;
  protocolToken?: string;
};

function makeScriptedWorker(autoFinish = true): ScriptedWorker {
  const listeners = {
    message: [] as ((event: { data?: unknown; isTrusted?: boolean }) => void)[],
    error: [] as ((event: { message?: string }) => void)[],
  };
  const posted: unknown[] = [];
  const scripted: ScriptedWorker = {
    listeners,
    posted,
    terminated: false,
    emit(message: unknown) {
      const framed = scripted.protocolToken && typeof message === "object" && message !== null && !Array.isArray(message)
        ? { ...message, protocolToken: scripted.protocolToken }
        : message;
      scripted.emitRaw(framed);
    },
    emitRaw(message: unknown) {
      for (const listener of [...listeners.message]) listener({ data: message, isTrusted: true });
    },
    fail(message: string) {
      for (const listener of listeners.error) listener({ message });
    },
    postMessage(message: unknown) {
      posted.push(message);
      const data = message as {
        type?: string;
        protocolToken?: string;
        job?: { jobId: string; code: string; label?: string };
        jobId?: string;
      };
      if (data.type === "init" && typeof data.protocolToken === "string") {
        scripted.protocolToken = data.protocolToken;
      }
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

function makeHost(
  worker: ScriptedWorker,
  budgets?: Partial<KernelBudgets>,
): { host: PrimeKernelHost; bridgeCalls: KernelBridgeCallRequest[] } {
  const bridgeCalls: KernelBridgeCallRequest[] = [];
  const host = new PrimeKernelHost({
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
  return { host, bridgeCalls };
}

function completedResult(jobId: string, overrides: Partial<KernelJobResult> = {}): KernelJobResult {
  return {
    jobId,
    engine: "javascript",
    outcome: "completed",
    valueJson: "null",
    stdout: "",
    stderr: "",
    bridgeCalls: 0,
    wallMs: 1,
    ...overrides,
  };
}

const EXACT_WORKER_HEADERS = Object.freeze({
  "Content-Type": "text/javascript; charset=utf-8",
  "Content-Security-Policy": PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
});

function preflightResponse(url: string, headers = new Headers(EXACT_WORKER_HEADERS)): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    type: "basic",
    url,
    headers,
    body: { cancel: vi.fn(async () => undefined) },
  } as unknown as Response;
}

async function waitForPostedType(worker: ScriptedWorker, type: string): Promise<void> {
  await vi.waitFor(() => {
    expect(worker.posted.some((message) => (message as { type?: string }).type === type)).toBe(true);
  });
}

describe("PrimeKernelHost default browser worker admission", () => {
  it("preflights the exact pinned URL before construction and gives the capability only to one init frame", async () => {
    const worker = makeScriptedWorker(false);
    const constructed: { url?: string; options?: WorkerOptions } = {};
    const policies = new Map<string, { createScriptURL(value: string): string }>();
    const fetchStub = vi.fn(async (input: string | URL, options?: RequestInit) =>
      preflightResponse(String(input)));

    vi.stubGlobal("location", new URL("https://airship.example/airship/"));
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("trustedTypes", {
      createPolicy(name: string, rules: { createScriptURL(value: string): string }) {
        policies.set(name, rules);
        return { createScriptURL: rules.createScriptURL };
      },
    });
    vi.stubGlobal("Worker", vi.fn(function WorkerDouble(url: string, options: WorkerOptions) {
      constructed.url = String(url);
      constructed.options = options;
      return worker;
    }));

    const host = new PrimeKernelHost({
      ports: { bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) } },
    });
    try {
      const boot = host.start();
      await waitForPostedType(worker, "init");
      worker.emit({ type: "ready", engine: "javascript" });
      await boot;

      expect(fetchStub).toHaveBeenCalledTimes(1);
      const [preflightUrl, request] = fetchStub.mock.calls[0]!;
      expect(String(preflightUrl)).toBe(constructed.url);
      expect(request).toMatchObject({ credentials: "omit", mode: "same-origin", redirect: "manual" });
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      expect(request?.signal?.aborted).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(request, "cache")).toBe(false);
      expect(constructed.options).toEqual({ credentials: "omit", name: "prime-kernel", type: "module" });

      const initFrames = worker.posted.filter((message) => (message as { type?: string }).type === "init") as Array<{
        protocolToken: string;
      }>;
      expect(initFrames).toHaveLength(1);
      expect(initFrames[0]!.protocolToken).toMatch(/^[0-9a-f]{64}$/u);
      expect(constructed.url).not.toContain(initFrames[0]!.protocolToken);

      const policy = policies.get("airship-prime-kernel-worker-asset");
      expect(policy).toBeDefined();
      expect(policy!.createScriptURL(constructed.url!)).toBe(constructed.url);
      expect(() => policy!.createScriptURL(new URL("assets/lookalike.js", location.href).href)).toThrow(/pinned/u);
      expect(() => policy!.createScriptURL(`${constructed.url}#fragment`)).toThrow(/pinned/u);
      expect(() => policy!.createScriptURL("https://attacker.example/worker.js")).toThrow(/pinned/u);
    } finally {
      await host.terminate("default-worker admission test complete");
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on a headerless or policy-drifted response before Worker construction", async () => {
    vi.stubGlobal("location", new URL("https://airship.example/airship/"));
    const construct = vi.fn(function WorkerMustNotRun() {
      throw new Error("Worker construction crossed a failed preflight.");
    });
    vi.stubGlobal("Worker", construct);

    const invalidResponses = [
      new Headers({ ...EXACT_WORKER_HEADERS, "Content-Security-Policy": "" }),
      new Headers({
        ...EXACT_WORKER_HEADERS,
        "Content-Security-Policy": `${PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY}, ${PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY}`,
      }),
      new Headers({
        ...EXACT_WORKER_HEADERS,
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
      }),
      new Headers({ ...EXACT_WORKER_HEADERS, "Cross-Origin-Embedder-Policy": "require-corp" }),
      new Headers({ ...EXACT_WORKER_HEADERS, "Cross-Origin-Resource-Policy": "cross-origin" }),
      new Headers({ ...EXACT_WORKER_HEADERS, "X-Content-Type-Options": "" }),
      new Headers({ ...EXACT_WORKER_HEADERS, "Content-Type": "text/html" }),
    ];

    try {
      for (const headers of invalidResponses) {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => preflightResponse(String(input), headers)));
        const host = new PrimeKernelHost({
          ports: { bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) } },
        });
        await expect(host.start()).rejects.toThrow(/preflight refused/u);
        expect(host.description().state).toBe("failed");
      }
      expect(construct).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses redirects and a response URL different from the pinned request", async () => {
    vi.stubGlobal("location", new URL("https://airship.example/airship/"));
    const construct = vi.fn();
    vi.stubGlobal("Worker", construct);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => ({
      ...preflightResponse(String(input)),
      redirected: true,
      url: "https://airship.example/airship/assets/replaced.js",
    })));
    try {
      const host = new PrimeKernelHost({
        ports: { bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) } },
      });
      await expect(host.start()).rejects.toThrow(/redirected, or changed URL/u);
      expect(construct).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });


  it("aborts and fences a pending preflight when terminate wins the boot race", async () => {
    vi.stubGlobal("location", new URL("https://airship.example/airship/"));
    let resolveFetch!: (response: Response) => void;
    let preflightUrl = "";
    let preflightSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: string | URL, options?: RequestInit) => {
      preflightUrl = String(input);
      preflightSignal = options?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    }));
    const construct = vi.fn();
    vi.stubGlobal("Worker", construct);
    const host = new PrimeKernelHost({
      ports: { bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) } },
    });
    try {
      const bootResult = host.start().then(
        () => new Error("stale boot unexpectedly completed"),
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(preflightSignal).toBeInstanceOf(AbortSignal));
      await host.terminate("terminate won the pending preflight race");
      expect(preflightSignal?.aborted).toBe(true);
      resolveFetch(preflightResponse(preflightUrl));
      expect(await bootResult).toBeInstanceOf(Error);
      expect(construct).not.toHaveBeenCalled();
      expect(host.description()).toMatchObject({ state: "stopped", generation: 0 });
    } finally {
      await host.terminate("pending-preflight terminate test complete");
      vi.unstubAllGlobals();
    }
  });

  it("keeps a restarted boot authoritative when the prior preflight resolves late", async () => {
    vi.stubGlobal("location", new URL("https://airship.example/airship/"));
    const preflights: Array<{
      url: string;
      signal?: AbortSignal;
      resolve(response: Response): void;
    }> = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL, options?: RequestInit) => new Promise<Response>((resolve) => {
      preflights.push({ url: String(input), signal: options?.signal ?? undefined, resolve });
    })));
    const workers: ScriptedWorker[] = [];
    const construct = vi.fn(function WorkerDouble() {
      const worker = makeScriptedWorker(false);
      workers.push(worker);
      return worker;
    });
    vi.stubGlobal("Worker", construct);
    const host = new PrimeKernelHost({
      ports: { bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) } },
    });
    try {
      const staleBoot = host.start().then(
        () => new Error("stale boot unexpectedly completed"),
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(preflights).toHaveLength(1));
      const restarted = host.restart();
      await vi.waitFor(() => expect(preflights).toHaveLength(2));
      expect(preflights[0]!.signal?.aborted).toBe(true);
      expect(preflights[1]!.signal?.aborted).toBe(false);

      preflights[0]!.resolve(preflightResponse(preflights[0]!.url));
      expect(await staleBoot).toBeInstanceOf(Error);
      expect(construct).not.toHaveBeenCalled();

      preflights[1]!.resolve(preflightResponse(preflights[1]!.url));
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      await waitForPostedType(workers[0]!, "init");
      workers[0]!.emit({ type: "ready", engine: "javascript" });
      await restarted;
      await host.start();
      expect(preflights).toHaveLength(2);
      expect(construct).toHaveBeenCalledTimes(1);
      expect(host.description()).toMatchObject({ state: "ready", generation: 0 });
    } finally {
      await host.terminate("pending-preflight restart test complete");
      vi.unstubAllGlobals();
    }
  });
});

describe("PrimeKernelHost (scripted worker)", () => {
  it("boots to ready and describes state", async () => {
    const worker = makeScriptedWorker();
    const { host } = makeHost(worker);
    const boot = host.start();
    expect(worker.posted[0]).toEqual({
      type: "init",
      budgets: DEFAULT_KERNEL_BUDGETS,
      protocolToken: worker.protocolToken,
    });
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    expect(host.description()).toMatchObject({ state: "ready", generation: 0 });
    expect(host.describe()).toMatchObject({ state: "ready", persistence: "job", generation: 0 });
  });

  it("fails boot closed on an unauthenticated or malformed ready frame", async () => {
    const worker = makeScriptedWorker();
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emitRaw({ type: "ready", engine: "javascript" });
    await expect(boot).rejects.toThrow("protocol violation during boot");
    expect(worker.terminated).toBe(true);
    expect(host.description().state).toBe("failed");
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

  it("refuses non-positive, unsafe, fractional, and over-policy timeoutMs values before dispatch", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker, { maxJobWallMs: 1_000 });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const invalid = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 1_001];
    for (const [index, timeoutMs] of invalid.entries()) {
      const result = await host.exec({ code: "return true", jobId: `invalid-timeout-${index}`, timeoutMs });
      expect(result).toMatchObject({ outcome: "failed", wallMs: 0 });
      expect(result.error).toContain("positive safe integer");
      expect(result.error).toContain("1000 ms");
    }
    expect(worker.posted.filter((message) => (message as { type?: string }).type === "exec")).toHaveLength(0);
  });

  it("refuses a non-positive maxJobWallMs policy", () => {
    const worker = makeScriptedWorker(false);
    expect(() => makeHost(worker, { maxJobWallMs: 0 })).toThrow(/positive safe integer/u);
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

  /*
   * A subscriber is an observer, not a participant. These fan-outs used to run
   * bare: one throwing listener wedged the dispatch before the exec frame and
   * before the wall clock, so the job never settled, the host stayed busy, and
   * every later job queued behind it forever.
   */
  it("settles a job even when every event subscriber throws", async () => {
    const worker = makeScriptedWorker();
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const seen: string[] = [];
    host.onEvent(() => { throw new Error("hostile global subscriber"); });
    host.onEvent((event) => { seen.push(`global:${event.type}`); });

    const first = await host.exec({ code: "true" }, () => { throw new Error("hostile job subscriber"); });
    expect(first.outcome).toBe("completed");
    // The queue is not poisoned: the host boots its next per-job worker and
    // runs the next job, which a wedged dispatch would never reach.
    const second = host.exec({ code: "true" });
    await waitForPostedType(worker, "init");
    worker.emit({ type: "ready", engine: "javascript" });
    expect((await second).outcome).toBe("completed");
    // A throwing subscriber does not silence the ones registered after it.
    expect(seen).toContain("global:completed");
    await host.terminate("throwing-subscriber test complete");
  });

  /*
   * Containment stops a subscriber throwing out of the dispatch frame; it does
   * not stop one calling back in. A subscriber that terminated the host from
   * inside `started` left dispatch arming a wall clock for a settled job and
   * posting `exec` at a worker that no longer existed.
   */
  it("stops dispatching when a subscriber tears the host down mid-announcement", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    host.onEvent((event) => {
      if (event.type === "started") void host.terminate("subscriber tore the host down");
    });

    const result = await host.exec({ code: "true", jobId: "job-reentrant", timeoutMs: 1_000 });
    expect(result.jobId).toBe("job-reentrant");
    expect(result.outcome).not.toBe("completed");
    // No exec frame reached the worker that was being torn down, and no stray
    // wall clock survives to kill a later job with this one's reason.
    expect(worker.posted.filter((message) => (message as { type?: string }).type === "exec")).toHaveLength(0);
  });

  it("snapshots caller-owned job fields before asynchronous boot admission", async () => {
    const worker = makeScriptedWorker(false);
    const host = new PrimeKernelHost({
      budgets: { maxSourceChars: 24, maxJobWallMs: 100 },
      ports: {
        bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) },
        workerFactory: () => worker,
      },
    });
    const spec = {
      jobId: "job-snapshotted",
      code: "return 'safe';",
      timeoutMs: 50,
      label: "safe-label",
    };

    const result = host.exec(spec);
    spec.jobId = "job-mutated";
    spec.code = "await pat.sleep(250); return 'MUTATED_AFTER_ADMISSION';";
    spec.timeoutMs = 1_000;
    spec.label = "mutated-label";
    worker.emit({ type: "ready", engine: "javascript" });

    await waitForPostedType(worker, "exec");
    const dispatched = worker.posted.find((message) => (message as { type?: string }).type === "exec");
    expect(dispatched).toEqual(expect.objectContaining({
      type: "exec",
      job: {
        jobId: "job-snapshotted",
        code: "return 'safe';",
        label: "safe-label",
      },
    }));
    worker.emit({
      type: "finished",
      jobId: "job-snapshotted",
      result: completedResult("job-snapshotted", { valueJson: JSON.stringify("safe") }),
    });
    await expect(result).resolves.toMatchObject({
      jobId: "job-snapshotted",
      outcome: "completed",
      valueJson: JSON.stringify("safe"),
    });
  });

  it("makes cancellation authoritative while cold worker boot is still pending", async () => {
    const worker = makeScriptedWorker(false);
    const host = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) },
        workerFactory: () => worker,
      },
    });

    const result = host.exec({
      jobId: "job-cancelled-during-boot",
      code: "return 'MUST_NOT_RUN';",
      timeoutMs: 1_000,
    });
    expect(host.cancel("job-cancelled-during-boot", "cancelled before ready")).toBe(true);
    await expect(result).resolves.toMatchObject({
      jobId: "job-cancelled-during-boot",
      outcome: "cancelled",
      error: "cancelled before ready",
    });

    worker.emit({ type: "ready", engine: "javascript" });
    await vi.waitFor(() => expect(host.describe().state).toBe("ready"));
    expect(worker.posted.some((message) => (message as { type?: string }).type === "exec")).toBe(false);
    await host.terminate("Cold cancellation test complete.");
  });

  it("never publishes completed after an active cancellation even when job code catches the abort", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const result = host.exec({ code: "return 'CAUGHT_CANCEL';", jobId: "job-caught-cancel" });
    expect(host.cancel("job-caught-cancel", "caller aborted the turn")).toBe(true);
    worker.emit({
      type: "finished",
      jobId: "job-caught-cancel",
      result: completedResult("job-caught-cancel", { valueJson: JSON.stringify("CAUGHT_CANCEL") }),
    });

    await expect(result).resolves.toMatchObject({
      jobId: "job-caught-cancel",
      outcome: "cancelled",
      error: "caller aborted the turn",
    });
    expect(worker.terminated).toBe(true);
  });

  it("hard-terminates an active worker that cannot process its cancellation frame", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const startedAt = Date.now();
    const result = host.exec({ code: "while (true) {}", jobId: "job-spinning-cancel", timeoutMs: 5_000 });
    expect(host.cancel("job-spinning-cancel", "stop hostile code")).toBe(true);
    await expect(result).resolves.toMatchObject({
      jobId: "job-spinning-cancel",
      outcome: "cancelled",
      error: expect.stringContaining("hard-terminated"),
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(worker.terminated).toBe(true);
  });

  it("withholds a hard-cancelled result until every admitted bridge effect settles", async () => {
    const worker = makeScriptedWorker(false);
    let settleBridge!: (value: KernelBridgeCallResult) => void;
    const bridge = new Promise<KernelBridgeCallResult>((resolve) => { settleBridge = resolve; });
    const host = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => bridge },
        workerFactory: () => worker,
      },
    });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const result = host.exec({ code: "void pat.call('write_file', {}); while (true) {}", jobId: "job-cancel-drains-bridge" });
    worker.emit({
      type: "bridge-request",
      jobId: "job-cancel-drains-bridge",
      call: { jobId: "job-cancel-drains-bridge", seq: 0, tool: "write_file", arguments: {} },
    });
    expect(host.cancel("job-cancel-drains-bridge", "cancel with admitted effect")).toBe(true);
    let published = false;
    void result.then(() => { published = true; });
    await new Promise((resolve) => setTimeout(resolve, PRIME_KERNEL_CANCEL_GRACE_MS + 20));
    expect(worker.terminated).toBe(true);
    expect(published).toBe(false);

    settleBridge({ seq: 0, ok: true, content: "{}" });
    await expect(result).resolves.toMatchObject({
      outcome: "cancelled",
      error: expect.stringContaining("hard-terminated"),
      bridgeCalls: 1,
    });
    expect(published).toBe(true);
  });

  it("registers a bridge effect before synchronous port code can terminate the host", async () => {
    const worker = makeScriptedWorker(false);
    let settleBridge!: (value: KernelBridgeCallResult) => void;
    const bridge = new Promise<KernelBridgeCallResult>((resolve) => { settleBridge = resolve; });
    let terminatePromise: Promise<void> | undefined;
    let host!: PrimeKernelHost;
    host = new PrimeKernelHost({
      ports: {
        bridge: {
          call(request) {
            terminatePromise = host.terminate("synchronous bridge termination");
            return bridge.then(() => ({ seq: request.seq, ok: true as const, content: "{}" }));
          },
        },
        workerFactory: () => worker,
      },
    });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const result = host.exec({ code: "await pat.call('write_file', {})", jobId: "job-reentrant-terminate" });
    worker.emit({
      type: "bridge-request",
      jobId: "job-reentrant-terminate",
      call: { jobId: "job-reentrant-terminate", seq: 0, tool: "write_file", arguments: {} },
    });
    let published = false;
    void result.then(() => { published = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminatePromise).toBeDefined();
    expect(worker.terminated).toBe(true);
    expect(published).toBe(false);

    settleBridge({ seq: 0, ok: true, content: "{}" });
    await expect(result).resolves.toMatchObject({
      outcome: "crashed",
      error: "synchronous bridge termination",
      bridgeCalls: 1,
    });
    await expect(terminatePromise).resolves.toBeUndefined();
    expect(published).toBe(true);
  });

  it("withholds a watchdog crash until every admitted bridge effect settles", async () => {
    const worker = makeScriptedWorker(false);
    let settleBridge!: (value: KernelBridgeCallResult) => void;
    const bridge = new Promise<KernelBridgeCallResult>((resolve) => { settleBridge = resolve; });
    const host = new PrimeKernelHost({
      budgets: { maxJobWallMs: 25 },
      ports: {
        bridge: { call: async () => bridge },
        workerFactory: () => worker,
      },
    });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const result = host.exec({ code: "await pat.call('write_file', {})", jobId: "job-watchdog-drains-bridge", timeoutMs: 25 });
    worker.emit({
      type: "bridge-request",
      jobId: "job-watchdog-drains-bridge",
      call: { jobId: "job-watchdog-drains-bridge", seq: 0, tool: "write_file", arguments: {} },
    });
    let published = false;
    void result.then(() => { published = true; });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(worker.terminated).toBe(true);
    expect(published).toBe(false);

    settleBridge({ seq: 0, ok: true, content: "{}" });
    await expect(result).resolves.toMatchObject({
      outcome: "crashed",
      error: expect.stringContaining("wall-clock budget"),
      bridgeCalls: 1,
    });
    expect(published).toBe(true);
  });

  it("breaks a bridge-to-same-host queued-job dependency before draining a timeout", async () => {
    const worker = makeScriptedWorker(false);
    let innerOutcome: KernelJobResult["outcome"] | undefined;
    let host!: PrimeKernelHost;
    host = new PrimeKernelHost({
      budgets: { maxJobWallMs: 25 },
      ports: {
        bridge: {
          async call(request) {
            const inner = await host.exec({ code: "return 'inner';", jobId: "job-recursive-inner", timeoutMs: 25 });
            innerOutcome = inner.outcome;
            return { seq: request.seq, ok: false, error: `inner ended ${inner.outcome}` };
          },
        },
        workerFactory: () => worker,
      },
    });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const outer = host.exec({ code: "await pat.call('recursive_probe', {})", jobId: "job-recursive-outer", timeoutMs: 25 });
    worker.emit({
      type: "bridge-request",
      jobId: "job-recursive-outer",
      call: { jobId: "job-recursive-outer", seq: 0, tool: "recursive_probe", arguments: {} },
    });

    await expect(outer).resolves.toMatchObject({
      outcome: "crashed",
      error: expect.stringContaining("wall-clock budget"),
    });
    expect(innerOutcome).toBe("cancelled");
    expect(host.describe().state).toBe("failed");
  });

  it("terminates each finished generation before dispatching the next queued job", async () => {
    const workers: ScriptedWorker[] = [];
    const host = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => ({ seq: 0, ok: true, content: "{}" }) },
        workerFactory: () => {
          const worker = makeScriptedWorker(false);
          workers.push(worker);
          queueMicrotask(() => worker.emit({ type: "ready", engine: "javascript" }));
          return worker;
        },
      },
    });

    const first = host.exec({ code: "return 1", jobId: "job-generation-one" });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    await waitForPostedType(workers[0]!, "exec");
    const second = host.exec({ code: "return 2", jobId: "job-generation-two" });
    workers[0]!.emit({
      type: "finished",
      jobId: "job-generation-one",
      result: completedResult("job-generation-one", { valueJson: "1" }),
    });
    await expect(first).resolves.toMatchObject({ outcome: "completed", valueJson: "1" });
    expect(workers[0]!.terminated).toBe(true);

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await waitForPostedType(workers[1]!, "exec");
    expect(workers[1]!.terminated).toBe(false);
    workers[1]!.emit({
      type: "finished",
      jobId: "job-generation-two",
      result: completedResult("job-generation-two", { valueJson: "2" }),
    });
    await expect(second).resolves.toMatchObject({ outcome: "completed", valueJson: "2" });
    expect(workers[1]!.terminated).toBe(true);
    expect(host.describe()).toMatchObject({ persistence: "job", generation: 2, state: "ready" });
  });

  it("routes bridge requests through the bridge port", async () => {
    const worker = makeScriptedWorker(false);
    const { host, bridgeCalls } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const job = host.exec({ code: "await pat.call('read_file', {})", jobId: "job-bridge" });
    worker.emit({
      type: "bridge-request",
      jobId: "job-bridge",
      call: { jobId: "job-bridge", seq: 0, tool: "read_file", arguments: {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].tool).toBe("read_file");
    expect(worker.posted.some((m: any) => m.type === "bridge-response")).toBe(true);
    worker.emit({
      type: "finished",
      jobId: "job-bridge",
      result: {
        jobId: "job-bridge", engine: "javascript", outcome: "completed", valueJson: "null",
        stdout: "", stderr: "", bridgeCalls: 1, wallMs: 1,
      },
    });
    await expect(job).resolves.toMatchObject({ outcome: "completed", bridgeCalls: 1 });
  });

  it("terminates a returned worker immediately but withholds completion until admitted bridge effects settle", async () => {
    const worker = makeScriptedWorker(false);
    let settleBridge!: (value: KernelBridgeCallResult) => void;
    const bridge = new Promise<KernelBridgeCallResult>((resolve) => { settleBridge = resolve; });
    const host = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => bridge },
        workerFactory: () => worker,
      },
    });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const job = host.exec({ code: "void pat.call('write_file', {}); return 'scheduled'", jobId: "job-unawaited-bridge" });
    worker.emit({
      type: "bridge-request",
      jobId: "job-unawaited-bridge",
      call: { jobId: "job-unawaited-bridge", seq: 0, tool: "write_file", arguments: {} },
    });
    worker.emit({
      type: "finished",
      jobId: "job-unawaited-bridge",
      result: completedResult("job-unawaited-bridge", { valueJson: JSON.stringify("scheduled"), bridgeCalls: 1 }),
    });

    let published = false;
    void job.then(() => { published = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.terminated).toBe(true);
    expect(published).toBe(false);

    settleBridge({ seq: 0, ok: true, content: "{}" });
    await expect(job).resolves.toMatchObject({
      outcome: "completed",
      valueJson: JSON.stringify("scheduled"),
      bridgeCalls: 1,
    });
    expect(published).toBe(true);
  });

  it("keeps cancellation authoritative when accepted during a deferred-finished bridge drain", async () => {
    const worker = makeScriptedWorker(false);
    let settleBridge!: (value: KernelBridgeCallResult) => void;
    const bridge = new Promise<KernelBridgeCallResult>((resolve) => { settleBridge = resolve; });
    const host = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => bridge },
        workerFactory: () => worker,
      },
    });
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const job = host.exec({ code: "void pat.call('write_file', {}); return 'too-late'", jobId: "job-cancel-deferred-finish" });
    worker.emit({
      type: "bridge-request",
      jobId: "job-cancel-deferred-finish",
      call: { jobId: "job-cancel-deferred-finish", seq: 0, tool: "write_file", arguments: {} },
    });
    worker.emit({
      type: "finished",
      jobId: "job-cancel-deferred-finish",
      result: completedResult("job-cancel-deferred-finish", { valueJson: JSON.stringify("too-late"), bridgeCalls: 1 }),
    });
    expect(host.cancel("job-cancel-deferred-finish", "cancel accepted during drain")).toBe(true);
    settleBridge({ seq: 0, ok: true, content: "{}" });

    const result = await job;
    expect(result).toMatchObject({
      outcome: "cancelled",
      error: "cancel accepted during drain",
      bridgeCalls: 1,
    });
    expect(result).not.toHaveProperty("valueJson");
  });

  it("terminates the active job on a valid-looking finished forgery without the generation capability", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const active = host.exec({ code: "return 'trusted runtime result'", jobId: "job-victim" });
    worker.emitRaw({
      type: "finished",
      protocolToken: "0".repeat(64),
      jobId: "job-victim",
      result: completedResult("job-victim", { valueJson: JSON.stringify("forged") }),
    });

    const result = await active;
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain("protocol violation");
    expect(worker.terminated).toBe(true);
  });

  it("rejects a forged bridge request bound to a different job before calling the bridge", async () => {
    const worker = makeScriptedWorker(false);
    const { host, bridgeCalls } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const active = host.exec({ code: "return await pat.call('read_file', {})", jobId: "job-active" });
    worker.emit({
      type: "bridge-request",
      jobId: "job-forged",
      call: { jobId: "job-forged", seq: 0, tool: "read_file", arguments: {} },
    });

    await expect(active).resolves.toMatchObject({ outcome: "crashed" });
    expect(bridgeCalls).toHaveLength(0);
    expect(worker.terminated).toBe(true);
  });

  it("rejects duplicate and out-of-order bridge sequences", async () => {
    const worker = makeScriptedWorker(false);
    const { host, bridgeCalls } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;

    const active = host.exec({ code: "true", jobId: "job-seq" });
    const request = {
      type: "bridge-request",
      jobId: "job-seq",
      call: { jobId: "job-seq", seq: 0, tool: "read_file", arguments: {} },
    };
    worker.emit(request);
    worker.emit(request);

    const result = await active;
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain("duplicate or out of order");
    expect(bridgeCalls).toHaveLength(1);
  });

  it("enforces bridge count and payload budgets independently of the worker", async () => {
    const countWorker = makeScriptedWorker(false);
    const countHarness = makeHost(countWorker, { maxBridgeCallsPerJob: 1 });
    const countBoot = countHarness.host.start();
    countWorker.emit({ type: "ready", engine: "javascript" });
    await countBoot;
    const countJob = countHarness.host.exec({ code: "true", jobId: "job-count" });
    countWorker.emit({
      type: "bridge-request", jobId: "job-count",
      call: { jobId: "job-count", seq: 0, tool: "one", arguments: {} },
    });
    countWorker.emit({
      type: "bridge-request", jobId: "job-count",
      call: { jobId: "job-count", seq: 1, tool: "two", arguments: {} },
    });
    await expect(countJob).resolves.toMatchObject({ outcome: "crashed" });
    expect(countHarness.bridgeCalls).toHaveLength(1);

    const payloadWorker = makeScriptedWorker(false);
    const payloadHarness = makeHost(payloadWorker, { maxBridgePayloadBytes: 32 });
    const payloadBoot = payloadHarness.host.start();
    payloadWorker.emit({ type: "ready", engine: "javascript" });
    await payloadBoot;
    const payloadJob = payloadHarness.host.exec({ code: "true", jobId: "job-payload" });
    payloadWorker.emit({
      type: "bridge-request", jobId: "job-payload",
      call: { jobId: "job-payload", seq: 0, tool: "write", arguments: { text: "x".repeat(64) } },
    });
    await expect(payloadJob).resolves.toMatchObject({ outcome: "crashed" });
    expect(payloadHarness.bridgeCalls).toHaveLength(0);
  });

  it.each([
    ["unknown frame", () => ({ type: "bridge-call", jobId: "job-malformed" })],
    ["out-of-order first sequence", () => ({
      type: "bridge-request",
      jobId: "job-malformed",
      call: { jobId: "job-malformed", seq: 1, tool: "read_file", arguments: {} },
    })],
    ["invalid finished valueJson", () => ({
      type: "finished",
      jobId: "job-malformed",
      result: completedResult("job-malformed", { valueJson: "not json" }),
    })],
    ["mismatched finished streams", () => ({
      type: "finished",
      jobId: "job-malformed",
      result: completedResult("job-malformed", { stdout: "invented output" }),
    })],
  ])("terminates on %s", async (_name, frame) => {
    const worker = makeScriptedWorker(false);
    const { host, bridgeCalls } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const active = host.exec({ code: "true", jobId: "job-malformed" });
    worker.emit(frame());
    await expect(active).resolves.toMatchObject({ outcome: "crashed" });
    expect(bridgeCalls).toHaveLength(0);
    expect(worker.terminated).toBe(true);
  });

  it("terminates the generation before resolving and ignores its later duplicate frame", async () => {
    const worker = makeScriptedWorker(false);
    const { host } = makeHost(worker);
    const boot = host.start();
    worker.emit({ type: "ready", engine: "javascript" });
    await boot;
    const active = host.exec({ code: "true", jobId: "job-finished" });
    const frame = { type: "finished", jobId: "job-finished", result: completedResult("job-finished") };
    worker.emit(frame);
    await expect(active).resolves.toMatchObject({ outcome: "completed" });
    expect(worker.terminated).toBe(true);
    expect(host.description()).toMatchObject({ state: "ready", generation: 1 });
    worker.emit(frame);
    expect(host.description()).toMatchObject({ state: "ready", generation: 1 });
  });

  it("rejects non-record and over-budget stream frames", async () => {
    const malformedWorker = makeScriptedWorker(false);
    const malformedHarness = makeHost(malformedWorker);
    const malformedBoot = malformedHarness.host.start();
    malformedWorker.emit({ type: "ready", engine: "javascript" });
    await malformedBoot;
    const malformedJob = malformedHarness.host.exec({ code: "true", jobId: "job-record" });
    malformedWorker.emitRaw(["stdout", malformedWorker.protocolToken]);
    await expect(malformedJob).resolves.toMatchObject({ outcome: "crashed" });

    const streamWorker = makeScriptedWorker(false);
    const streamHarness = makeHost(streamWorker, { maxStreamChars: 4 });
    const streamBoot = streamHarness.host.start();
    streamWorker.emit({ type: "ready", engine: "javascript" });
    await streamBoot;
    const streamJob = streamHarness.host.exec({ code: "true", jobId: "job-stream" });
    streamWorker.emit({ type: "stdout", jobId: "job-stream", text: "12345" });
    await expect(streamJob).resolves.toMatchObject({ outcome: "crashed" });
  });

  it("charges newline/frame overhead and caps empty stream-frame amplification", async () => {
    const boundedWorker = makeScriptedWorker(false);
    const boundedHarness = makeHost(boundedWorker, { maxStreamChars: 4 });
    const boundedBoot = boundedHarness.host.start();
    boundedWorker.emit({ type: "ready", engine: "javascript" });
    await boundedBoot;
    const boundedJob = boundedHarness.host.exec({ code: "true", jobId: "job-stream-boundaries" });
    boundedWorker.emit({ type: "stdout", jobId: "job-stream-boundaries", text: "a" });
    boundedWorker.emit({ type: "stdout", jobId: "job-stream-boundaries", text: "b" });
    boundedWorker.emit({
      type: "finished",
      jobId: "job-stream-boundaries",
      result: completedResult("job-stream-boundaries", { stdout: "a\nb" }),
    });
    await expect(boundedJob).resolves.toMatchObject({ outcome: "completed", stdout: "a\nb" });

    const floodWorker = makeScriptedWorker(false);
    const floodHarness = makeHost(floodWorker, { maxStreamChars: MAX_KERNEL_STREAM_FRAMES + 16 });
    const floodBoot = floodHarness.host.start();
    floodWorker.emit({ type: "ready", engine: "javascript" });
    await floodBoot;
    const floodJob = floodHarness.host.exec({ code: "true", jobId: "job-empty-frame-flood" });
    for (let index = 0; index <= MAX_KERNEL_STREAM_FRAMES; index += 1) {
      floodWorker.emit({ type: "stdout", jobId: "job-empty-frame-flood", text: "" });
    }
    await expect(floodJob).resolves.toMatchObject({ outcome: "crashed" });
    expect(floodWorker.terminated).toBe(true);
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
    const active = host.exec({ code: "long", jobId: "job-long" });
    const queued = host.exec({ code: "queued", jobId: "job-queued" });
    await host.terminate("policy replacement");
    const activeResult = await active;
    const queuedResult = await queued;
    expect(activeResult.outcome).toBe("crashed");
    expect(queuedResult.outcome).toBe("cancelled");
    expect(host.description().state).toBe("stopped");
  });

  it("worker-source contains the ambient-removal list (egress honesty)", () => {
    const source = kernelWorkerSource(DEFAULT_KERNEL_BUDGETS);
    for (const name of AMBIENT_CHANNEL_NAMES) {
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
    const controllerListeners: ((event: { data: unknown; isTrusted: true }) => void)[] = [];
    const sandbox: Record<string, unknown> = {
      postMessage: (message: Record<string, unknown>) => { posted.push(message); },
      addEventListener: (type: string, listener: (event: { data: unknown; isTrusted: true }) => void) => {
        if (type === "message") controllerListeners.push(listener);
      },
      removeEventListener: (type: string, listener: (event: { data: unknown; isTrusted: true }) => void) => {
        if (type !== "message") return;
        const index = controllerListeners.indexOf(listener);
        if (index >= 0) controllerListeners.splice(index, 1);
      },
      dispatchEvent: () => false,
      TextEncoder,
      AbortController,
      setTimeout,
      clearTimeout,
    };
    const context = createContext(sandbox);
    // Model the browser's WorkerGlobalScope prototype surface, not only own
    // globals, so the test fails if removal regresses to name shadowing.
    runInContext(`
      for (const name of ${JSON.stringify(AMBIENT_CHANNEL_NAMES)}) {
        Object.defineProperty(Object.getPrototypeOf(globalThis), name, {
          value: function ambientChannel() {}, configurable: true, writable: true
        });
      }
    `, context);
    runInContext(kernelWorkerSource(DEFAULT_KERNEL_BUDGETS), context);
    return {
      posted,
      send: (message: unknown) => {
        for (const listener of [...controllerListeners]) listener({ data: message, isTrusted: true });
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

  it("removes ambient channels from both the global and its prototype chain", async () => {
    const worker = bootWorkerSource();
    worker.send({
      type: "exec",
      job: {
        jobId: "job-ambient-prototypes",
        code: `
          const exposed = [];
          for (const name of ${JSON.stringify(AMBIENT_CHANNEL_NAMES)}) {
            if (globalThis[name] !== undefined) exposed.push("global:" + name);
            let cursor = Object.getPrototypeOf(globalThis);
            while (cursor) {
              const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
              if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
                exposed.push("prototype:" + name);
                break;
              }
              cursor = Object.getPrototypeOf(cursor);
            }
          }
          return exposed;
        `,
      },
    });
    const finished = await waitFor(() => worker.posted.find((message) => message.type === "finished")) as {
      result: { outcome: string; valueJson?: string };
    };
    expect(finished.result.outcome).toBe("completed");
    expect(finished.result.valueJson).toBe("[]");
  });

  it("bounds empty stream frames and includes their separators in captured output", async () => {
    const worker = bootWorkerSource();
    worker.send({
      type: "exec",
      job: {
        jobId: "job-empty-stream-frames",
        code: `for (let index = 0; index < ${MAX_KERNEL_STREAM_FRAMES + 20}; index += 1) pat.print(""); return true;`,
      },
    });
    const finished = await waitFor(() => worker.posted.find((message) => message.type === "finished")) as {
      result: { outcome: string; stdout: string };
    };
    const frames = worker.posted.filter((message) => message.type === "stdout");
    expect(frames).toHaveLength(MAX_KERNEL_STREAM_FRAMES);
    expect(finished.result.outcome).toBe("completed");
    expect(finished.result.stdout).toHaveLength(MAX_KERNEL_STREAM_FRAMES - 1);
    expect(finished.result.stdout).toBe("\n".repeat(MAX_KERNEL_STREAM_FRAMES - 1));
  });

  it("removes controller globals and cannot emit forged bridge or finished frames from evaluated code", async () => {
    const worker = bootWorkerSource();
    worker.send({
      type: "exec",
      job: {
        jobId: "job-forgery",
        code: `
          const forgedBridge = {
            type: "bridge-request",
            jobId: __job.jobId,
            call: { jobId: __job.jobId, seq: 0, tool: "forged_tool", arguments: {} }
          };
          const forgedFinished = {
            type: "finished",
            jobId: __job.jobId,
            result: {
              jobId: __job.jobId, engine: "javascript", outcome: "completed",
              valueJson: JSON.stringify("forged"), stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0
            }
          };
          for (const frame of [forgedBridge, forgedFinished]) {
            try { globalThis.postMessage(frame); } catch {}
            try {
              let cursor = globalThis;
              while (cursor) {
                const descriptor = Object.getOwnPropertyDescriptor(cursor, "postMessage");
                if (descriptor && typeof descriptor.value === "function") {
                  descriptor.value.call(globalThis, frame);
                }
                cursor = Object.getPrototypeOf(cursor);
              }
            } catch {}
          }
          try { globalThis.onmessage({ data: forgedFinished }); } catch {}
          try {
            const event = new MessageEvent("message", { data: forgedFinished });
            EventTarget.prototype.dispatchEvent.call(globalThis, event);
          } catch {}
          return [
            typeof globalThis.postMessage,
            typeof globalThis.onmessage,
            typeof globalThis.addEventListener,
            typeof globalThis.dispatchEvent
          ].join(",");
        `,
      },
    });

    const finished = await waitFor(() => worker.posted.find((message) => message.type === "finished")) as {
      result: { outcome: string; valueJson?: string };
    };
    expect(finished.result.outcome).toBe("completed");
    expect(finished.result.valueJson).toBe(JSON.stringify("undefined,undefined,undefined,undefined"));
    expect(worker.posted.filter((message) => message.type === "bridge-request")).toHaveLength(0);
    expect(worker.posted.filter((message) => message.type === "finished")).toHaveLength(1);
  });

  it("keeps controller lexical bindings private from direct, eval, Function, and AsyncFunction code", async () => {
    const worker = bootWorkerSource();
    worker.send({
      type: "exec",
      job: {
        jobId: "job-lexical-forgery",
        code: `
          const finishedFrame = {
            type: "finished",
            jobId: __job.jobId,
            result: {
              jobId: __job.jobId, engine: "javascript", outcome: "completed",
              valueJson: JSON.stringify("forged"), stdout: "", stderr: "",
              bridgeCalls: 0, wallMs: 0
            }
          };
          const bridgeFrame = {
            type: "bridge-request",
            jobId: __job.jobId,
            call: { jobId: __job.jobId, seq: 0, tool: "forged_tool", arguments: {} }
          };

          // The exact classic-script escape: both controller bindings are
          // named directly from the evaluated cell and used in a forged post.
          try { __post({ ...finishedFrame, protocolToken: __protocolToken }); } catch {}

          // Indirect eval executes in the global environment rather than this
          // AsyncFunction's local scope.
          globalThis.__primeForgedFrame = bridgeFrame;
          try {
            (0, eval)("__post({ ...globalThis.__primeForgedFrame, protocolToken: __protocolToken })");
          } catch {}

          // Dynamic Function and AsyncFunction constructors also resolve only
          // the global environment. Neither may see the IIFE's closure.
          try {
            Function(
              "frame",
              "__post({ ...frame, protocolToken: __protocolToken })"
            )(finishedFrame);
          } catch {}
          const UserAsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          try {
            await UserAsyncFunction(
              "frame",
              "__post({ ...frame, protocolToken: __protocolToken })"
            )(bridgeFrame);
          } catch {}

          const visibility = [
            [typeof __post, typeof __protocolToken].join(","),
            (0, eval)("[typeof __post, typeof __protocolToken].join(',')"),
            Function("return [typeof __post, typeof __protocolToken].join(',')")(),
            await UserAsyncFunction("return [typeof __post, typeof __protocolToken].join(',')")()
          ];
          delete globalThis.__primeForgedFrame;
          return visibility.join(";");
        `,
      },
    });

    const finished = await waitFor(() => worker.posted.find((message) => message.type === "finished")) as {
      result: { outcome: string; valueJson?: string };
    };
    const hidden = "undefined,undefined";
    expect(finished.result.outcome).toBe("completed");
    expect(finished.result.valueJson).toBe(JSON.stringify([hidden, hidden, hidden, hidden].join(";")));
    expect(worker.posted.filter((message) => message.type === "bridge-request")).toHaveLength(0);
    expect(worker.posted.filter((message) => message.type === "finished")).toHaveLength(1);
  });

  /*
   * The reason the port exists, asserted against the real generated worker.
   *
   * prime-agent's model does not emit a tool-call envelope to delegate — it
   * writes `await rlm("do this subtask", { name: "reviewer" })` inside the
   * kernel job. Registering the RLM tools on the host made delegation
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
