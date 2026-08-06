/**
 * execute_code: the model-facing tool over the persistent prime kernel.
 * These tests run the REAL tool against the REAL PrimeKernelHost with a
 * scripted in-process worker (the pattern from kernel-host.test.ts), so
 * the assertions cover the full seam: job id derivation from the
 * approval-bound operationId, live onOutput streaming (which can never
 * poison execution), the bounded durable result with its truncation
 * markers, isError on non-completed outcomes, and the aborted turn signal
 * cancelling the kernel job.
 */
import { describe, expect, it } from "vitest";
import type { KernelJobResult } from "../kernel/kernel-contract";
import type { KernelWorkerLike } from "../kernel/kernel-host";
import { PrimeKernelHost } from "../kernel/kernel-host";
import { createPrimeExecuteCodeTool } from "./kernel-tool";
import { makeToolContext } from "./test-utils";

type ScriptedWorker = KernelWorkerLike & {
  emit(message: unknown): void;
  posted: unknown[];
};

type WorkerScript =
  | Readonly<{ frames?: readonly Readonly<{ stream: "stdout" | "stderr"; text: string }>[]; result: KernelJobResult }>
  | Readonly<{ hold: true; cancelResult: (reason: string) => KernelJobResult }>;

function makeScriptedWorker(script: WorkerScript): ScriptedWorker {
  const listeners: ((event: { data?: unknown }) => void)[] = [];
  const worker: ScriptedWorker = {
    posted: [],
    emit(message: unknown) {
      for (const listener of listeners) listener({ data: message });
    },
    postMessage(message: unknown) {
      worker.posted.push(message);
      const data = message as Readonly<{ type?: string; job?: Readonly<{ jobId: string }>; jobId?: string; reason?: string }>;
      if (data.type === "exec" && data.job && "result" in script) {
        for (const frame of script.frames ?? []) {
          worker.emit({ type: frame.stream, jobId: data.job.jobId, text: frame.text });
        }
        worker.emit({ type: "finished", jobId: data.job.jobId, result: { ...script.result, jobId: data.job.jobId } });
      }
      if (data.type === "cancel" && data.jobId && "hold" in script) {
        worker.emit({ type: "finished", jobId: data.jobId, result: { ...script.cancelResult(data.reason ?? ""), jobId: data.jobId } });
      }
    },
    terminate() {
      /* the scripted worker never needs disposal */
    },
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === "message") listeners.push(listener as (event: { data?: unknown }) => void);
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      if (type !== "message") return;
      const index = listeners.indexOf(listener as (event: { data?: unknown }) => void);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return worker;
}

async function booted(script: WorkerScript): Promise<{ host: PrimeKernelHost; worker: ScriptedWorker }> {
  const worker = makeScriptedWorker(script);
  const host = new PrimeKernelHost({
    ports: {
      bridge: { call: () => Promise.resolve({ seq: 0, ok: true as const, content: "{}" }) },
      workerFactory: () => worker,
    },
  });
  const started = host.start();
  worker.emit({ type: "ready", engine: "javascript" });
  await started;
  return { host, worker };
}

function completedResult(overrides: Partial<KernelJobResult> = {}): KernelJobResult {
  return {
    jobId: "placeholder",
    engine: "javascript",
    outcome: "completed",
    stdout: "",
    stderr: "",
    bridgeCalls: 0,
    wallMs: 1,
    ...overrides,
  };
}

describe("prime execute_code", () => {
  it("executes through the kernel, streams stdout/stderr via onOutput, and shapes the banner result", async () => {
    const { host, worker } = await booted({
      frames: [
        { stream: "stdout", text: "hello\n" },
        { stream: "stderr", text: "warn\n" },
      ],
      result: completedResult({ stdout: "hello\n", stderr: "warn\n", valueJson: "42", wallMs: 7 }),
    });
    const tool = createPrimeExecuteCodeTool(host);
    const context = makeToolContext({ operationId: "op-7" });
    const result = await tool.execute({ code: "return 42" }, context);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Job prime-exec-op-7 completed in 7 ms (javascript kernel, 0 bridge calls).");
    expect(result.content).toContain("[stdout]\nhello\n");
    expect(result.content).toContain("[stderr]\nwarn\n");
    expect(result.content).toContain("[result]\n42");
    expect(result.metadata).toMatchObject({
      jobId: "prime-exec-op-7",
      engine: "javascript",
      outcome: "completed",
      bridgeCalls: 0,
      wallMs: 7,
      jobTimeoutMs: 300_000,
      stdoutChars: 6,
      stderrChars: 5,
      valueChars: 2,
      truncation: { stdout: false, stderr: false, value: false },
    });
    // The approval-bound operationId drives the job id the worker saw.
    expect(worker.posted).toContainEqual({ type: "exec", job: { jobId: "prime-exec-op-7", code: "return 42", label: "tool" } });
    expect(context.output).toEqual([
      { stream: "stdout", text: "hello\n" },
      { stream: "stderr", text: "warn\n" },
    ]);
  });

  it("survives a throwing onOutput observer: page-memory output can never poison execution", async () => {
    const { host } = await booted({
      frames: [{ stream: "stdout", text: "hello" }],
      result: completedResult({ stdout: "hello" }),
    });
    const tool = createPrimeExecuteCodeTool(host);
    const context = makeToolContext({
      operationId: "op-observer",
      onOutput: () => {
        throw new Error("view blew up");
      },
    });
    const result = await tool.execute({ code: "print('hello')" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[stdout]\nhello");
    expect(context.output).toEqual([{ stream: "stdout", text: "hello" }]);
  });

  it("bounds the durable result: stdout keeps the head, stderr the tail, markers name kept/total", async () => {
    const stdout = `FIRST-${"S".repeat(69_994)}`;
    const stderr = `HEAD${"E".repeat(69_992)}TAIL`;
    const { host } = await booted({
      result: completedResult({ stdout, stderr, valueJson: "V".repeat(70_000) }),
    });
    const tool = createPrimeExecuteCodeTool(host);
    const result = await tool.execute({ code: "emit" }, makeToolContext({ operationId: "op-8" }));

    const stdoutMarker = "[\u2026 stdout truncated: kept first 65536 of 70000 chars \u2026]";
    const stderrMarker = "[\u2026 stderr truncated: kept last 65536 of 70000 chars \u2026]";
    const valueMarker = "[\u2026 result value truncated: kept first 65536 of 70000 chars \u2026]";
    // stdout kept its HEAD: the marker leads and the kept head starts the stream.
    expect(result.content).toContain(`${stdoutMarker}\nFIRST-${"S".repeat(58)}`);
    expect(result.content).not.toContain("S".repeat(65_537));
    // stderr kept its TAIL: the marker trails the kept tail, the dropped head is gone.
    expect(result.content).toContain(`TAIL\n${stderrMarker}`);
    expect(result.content).not.toContain("HEAD");
    expect(result.content).toContain(`\n${valueMarker}`);
    expect(result.content).not.toContain("V".repeat(65_537));
    expect(result.metadata).toMatchObject({
      truncation: {
        stdout: { kept: 65_536, total: 70_000, keptFrom: "head" },
        stderr: { kept: 65_536, total: 70_000, keptFrom: "tail" },
        value: { kept: 65_536, total: 70_000, keptFrom: "head" },
      },
      stdoutChars: 70_000,
      stderrChars: 70_000,
      valueChars: 70_000,
    });
  });

  it("marks a failed outcome isError and surfaces the error section", async () => {
    const { host } = await booted({
      result: completedResult({ outcome: "failed", error: "ReferenceError: nope", stderr: "Traceback line", wallMs: 3 }),
    });
    const tool = createPrimeExecuteCodeTool(host);
    const result = await tool.execute({ code: "nope()" }, makeToolContext({ operationId: "op-9" }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Job prime-exec-op-9 failed in 3 ms (javascript kernel, 0 bridge calls).");
    expect(result.content).toContain("[stderr]\nTraceback line");
    expect(result.content).toContain("[error]\nReferenceError: nope");
    expect(result.metadata).toMatchObject({ jobId: "prime-exec-op-9", outcome: "failed" });
  });

  it("an aborted turn signal cancels the kernel job with the tool's named reason", async () => {
    const { host, worker } = await booted({
      hold: true,
      cancelResult: (reason) => completedResult({ outcome: "cancelled", error: reason, wallMs: 2 }),
    });
    const tool = createPrimeExecuteCodeTool(host);
    const controller = new AbortController();
    const executing = tool.execute(
      { code: "while (true) {}" },
      makeToolContext({ operationId: "op-abort", signal: controller.signal }),
    );
    // Let the job dispatch before aborting, so the cancel has to reach the worker.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.posted).toContainEqual({ type: "exec", job: { jobId: "prime-exec-op-abort", code: "while (true) {}", label: "tool" } });

    controller.abort();
    const result = await executing;
    expect(worker.posted).toContainEqual({ type: "cancel", jobId: "prime-exec-op-abort", reason: "execute_code was aborted by the turn." });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Job prime-exec-op-abort cancelled in 2 ms");
    expect(result.content).toContain("[error]\nexecute_code was aborted by the turn.");
    expect(result.metadata).toMatchObject({ jobId: "prime-exec-op-abort", outcome: "cancelled" });
  });

  it("refuses out-of-range jobTimeoutMs before any job reaches the kernel", async () => {
    const { host, worker } = await booted({ result: completedResult() });
    const tool = createPrimeExecuteCodeTool(host);
    await expect(tool.execute({ code: "x", jobTimeoutMs: 50 }, makeToolContext())).rejects.toThrow(
      "jobTimeoutMs must be between 100 and 300000 ms.",
    );
    await expect(tool.execute({ code: "x", jobTimeoutMs: 5_000.5 }, makeToolContext())).rejects.toThrow(
      "jobTimeoutMs must be an integer.",
    );
    await expect(tool.execute({ code: "   " }, makeToolContext())).rejects.toThrow("code must be a non-empty string.");
    expect(worker.posted.filter((message) => (message as Readonly<{ type?: string }>).type === "exec")).toHaveLength(0);
  });
});
