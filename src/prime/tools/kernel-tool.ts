/**
 * The prime `execute_code` tool: the model-facing door into the
 * persistent prime kernel (src/prime/kernel/*).
 *
 * Why the envelope looks the way it does:
 *   - the kernel is a *persistent* REPL worker (namespace survives across
 *     calls, resets are crash-reported), not a disposable executor — so
 *     this tool mints one job per call, forwards stream frames to the
 *     live output observer, and shapes the outcome from the captured,
 *     budgeted job result. The final bounded result is the durable
 *     authority; the live frames are page-memory presentation
 *     (src/core/contracts.ts ToolContext.onOutput), and the observer is
 *     never allowed to poison execution, so observer errors are swallowed
 *     exactly as airship's emitExecutionOutput swallows them;
 *   - abort is honored as cancellation: ToolContext.signal cancels the
 *     kernel job (cooperative first; the kernel's own kill timer is the
 *     hard boundary);
 *   - the tool must not await a job beyond the job's own budget: a
 *     watchdog at timeout + grace cancels the job (crucially, a job
 *     *queued behind* another job is cancelled before it ever runs), and
 *     a final settle grace synthesizes an explicitly-named
 *     watchdog-timeout result rather than hanging the turn;
 *   - the job id is derived from the approval-bound operationId, so
 *     journal records from the kernel bridge
 *     (`prime.kernel.tool.*`, kernelOperationId = prime-kernel:&lt;jobId&gt;:&lt;seq&gt;)
 *     join this tool's operation without a lookup table.
 */

import type { JsonValue, Tool, ToolContext, ToolExecutionResult, ToolOutputChunk } from "../../core/contracts";
import type { KernelJobResult } from "../kernel/kernel-contract";
import type { PrimeKernelHost } from "../kernel/kernel-host";
import { objectArguments, requiredString } from "../../tools/schema";

/**
 * Source ceiling, mirroring the kernel's own maxSourceChars default
 * (kernel-contract.ts DEFAULT_KERNEL_BUDGETS). The schema refuses past it
 * so the job never reaches the kernel to be refused there.
 */
const MAX_EXEC_CODE_CHARS = 256 * 1_024;
/** Job wall-clock ceiling mirrors the kernel default maxJobWallMs (5 minutes). */
const MAX_JOB_TIMEOUT_MS = 5 * 60 * 1_000;
const MIN_JOB_TIMEOUT_MS = 100;
/**
 * Time after the job budget at which the tool stops waiting on the
 * kernel. The kernel resolves every job on its own kill timer, so this
 * grace plus a settle window exists for two real cases: a job queued
 * behind another (the watchdog cancels it before it ever runs) and a
 * wedged worker that never learned it died.
 */
const WATCHDOG_GRACE_MS = 5_000;
/** Final settle window after the watchdog cancels; a job that outlives it is reported as a named watchdog timeout. */
const WATCHDOG_SETTLE_MS = 2_000;
/** Per-frame live-output slice, matching airship's host-side onOutput slice (execution-tools.ts). */
const LIVE_CHUNK_CHARS = 4_097;
/** Presentation bounds for the durable result; the registry's 1 MiB ceiling is never in reach. */
const MAX_PRESENT_STDOUT_CHARS = 64 * 1_024;
const MAX_PRESENT_STDERR_CHARS = 64 * 1_024;
const MAX_PRESENT_VALUE_CHARS = 64 * 1_024;
/** Default job budget when the caller names none: the kernel's documented default maxJobWallMs. */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

export type PrimeExecuteCodeOptions = Readonly<{
  /** Label journaled with kernel jobs for human docks ("rlm", "review"). */
  label?: string;
}>;


function emitOutput(onOutput: ToolContext["onOutput"], chunk: ToolOutputChunk): void {
  try {
    onOutput?.(chunk);
  } catch {
    /*
     * Output projection is deliberately non-authoritative (the same rule
     * airship's emitExecutionOutput encodes): the bounded final tool
     * result stays the source of truth even when a view misbehaves or
     * unmounts mid-stream.
     */
  }
}

function sliceHead(text: string, maxChars: number): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function sliceTail(text: string, maxChars: number): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}

/**
 * The durable result body. stdout keeps its head (progress and early
 * prints), stderr keeps its tail (tracebacks die at the end), and every
 * truncation names kept/total so the model can ask for the rest through
 * the kernel instead of assuming the middle was empty.
 */
function renderJobContent(result: KernelJobResult): Readonly<{ content: string; truncation: JsonValue }> {
  const stdout = sliceHead(result.stdout, MAX_PRESENT_STDOUT_CHARS);
  const stderr = sliceTail(result.stderr, MAX_PRESENT_STDERR_CHARS);
  const stdoutMarker = stdout.truncated
    ? `[… stdout truncated: kept first ${String(MAX_PRESENT_STDOUT_CHARS)} of ${String(result.stdout.length)} chars …]\n`
    : "";
  const stderrMarker = stderr.truncated
    ? `\n[… stderr truncated: kept last ${String(MAX_PRESENT_STDERR_CHARS)} of ${String(result.stderr.length)} chars …]`
    : "";
  const sections: string[] = [];
  if (result.stdout.length > 0) sections.push(`[stdout]\n${stdoutMarker}${stdout.text}${stderrMarker === "" ? "" : ""}`);
  if (result.stderr.length > 0) sections.push(`[stderr]\n${stderr.text}${stderrMarker}`);
  if (result.valueJson !== undefined) {
    const value = sliceHead(result.valueJson, MAX_PRESENT_VALUE_CHARS);
    const valueMarker = value.truncated ? `\n[… result value truncated: kept first ${String(MAX_PRESENT_VALUE_CHARS)} of ${String(result.valueJson.length)} chars …]` : "";
    sections.push(`[result]\n${value.text}${valueMarker}`);
  }
  if (result.error !== undefined && result.outcome !== "completed") {
    sections.push(`[error]\n${sliceHead(result.error, MAX_PRESENT_VALUE_CHARS).text}`);
  }
  const banner = `Job ${result.jobId} ${result.outcome} in ${String(result.wallMs)} ms (${result.engine} kernel, ${String(result.bridgeCalls)} bridge call${result.bridgeCalls === 1 ? "" : "s"}).`;
  return {
    content: sections.length > 0 ? `${banner}\n\n${sections.join("\n\n")}` : `${banner} No output.`,
    truncation: Object.freeze({
      stdout: stdout.truncated ? { kept: MAX_PRESENT_STDOUT_CHARS, total: result.stdout.length, keptFrom: "head" } : false,
      stderr: stderr.truncated ? { kept: MAX_PRESENT_STDERR_CHARS, total: result.stderr.length, keptFrom: "tail" } : false,
      value: result.valueJson !== undefined && result.valueJson.length > MAX_PRESENT_VALUE_CHARS
        ? { kept: MAX_PRESENT_VALUE_CHARS, total: result.valueJson.length, keptFrom: "head" }
        : false,
    }),
  };
}

function parseTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error("jobTimeoutMs must be an integer.");
  const timeout = value as number;
  if (timeout < MIN_JOB_TIMEOUT_MS || timeout > MAX_JOB_TIMEOUT_MS) {
    throw new Error(`jobTimeoutMs must be between ${String(MIN_JOB_TIMEOUT_MS)} and ${String(MAX_JOB_TIMEOUT_MS)} ms.`);
  }
  return timeout;
}

export function createPrimeExecuteCodeTool(
  kernel: PrimeKernelHost,
  options: PrimeExecuteCodeOptions = {},
): Tool {
  return {
    definition: {
      name: "execute_code",
      description:
        "Run JavaScript in the persistent prime kernel worker (namespace survives across calls until a crash resets it). " +
        "No ambient network/storage/DOM; workspace and host effects go through the reviewed tool bridge (pat.call). " +
        `Bounded to ${String(MAX_EXEC_CODE_CHARS)} source chars, ${String(MAX_JOB_TIMEOUT_MS / 1_000)} s per job, and a bounded result.`,
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1, maxLength: MAX_EXEC_CODE_CHARS },
          jobTimeoutMs: { type: "integer", minimum: MIN_JOB_TIMEOUT_MS, maximum: MAX_JOB_TIMEOUT_MS },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context: ToolContext): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const code = requiredString(args.code, "code");
      const jobTimeoutMs = parseTimeout(args.jobTimeoutMs) ?? DEFAULT_JOB_TIMEOUT_MS;
      /*
       * The job id binds this tool operation to every kernel-bridge
       * journal record the job produces: kernelOperationId(jobId, seq)
       * embeds the job id, and it embeds this approval-bound operationId,
       * so the whole chain (turn operation → kernel job → bridged tool
       * operations) joins without any side table.
       */
      const jobId = `prime-exec-${context.operationId}`;

      const jobPromise = kernel.exec(
        { jobId, code, timeoutMs: jobTimeoutMs, label: options.label ?? "tool" },
        (event) => {
          if (event.type === "stdout") emitOutput(context.onOutput, { stream: "stdout", text: event.text.slice(0, LIVE_CHUNK_CHARS) });
          if (event.type === "stderr") emitOutput(context.onOutput, { stream: "stderr", text: event.text.slice(0, LIVE_CHUNK_CHARS) });
        },
      );

      const onAbort = (): void => {
        kernel.cancel(jobId, "execute_code was aborted by the turn.");
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();

      /*
       * The watchdog is the tool's promise not to await a job longer than
       * the job's own budget (plus the named grace/settle windows). The
       * common case it resolves is a job *queued* behind another: cancel
       * removes it from the queue and the promise settles immediately.
       */
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const watchdog = new Promise<Readonly<{ watchdog: true }>>((resolve) => {
        watchdogTimer = setTimeout(() => {
          kernel.cancel(jobId, `execute_code watchdog fired after ${String(jobTimeoutMs + WATCHDOG_GRACE_MS)} ms; the kernel job was cancelled.`);
          settleTimer = setTimeout(() => resolve(Object.freeze({ watchdog: true as const })), WATCHDOG_SETTLE_MS);
        }, jobTimeoutMs + WATCHDOG_GRACE_MS);
      });

      const finished = jobPromise.then((result) => Object.freeze({ job: result }));
      const race = await Promise.race([finished, watchdog]);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (settleTimer) clearTimeout(settleTimer);
      context.signal.removeEventListener("abort", onAbort);
      settled = true;
      void settled;

      if ("watchdog" in race) {
        return {
          content:
            `execute_code stopped waiting for kernel job ${jobId} after ${String(jobTimeoutMs + WATCHDOG_GRACE_MS + WATCHDOG_SETTLE_MS)} ms and cancelled it. ` +
            "The kernel did not confirm the job's end inside the budget plus the watchdog windows; the namespace may have been reset by the cancellation.",
          isError: true,
          metadata: { jobId, engine: "javascript", outcome: "cancelled", watchdogTimeout: true, jobTimeoutMs },
        };
      }

      const result = race.job;
      const rendered = renderJobContent(result);
      return {
        content: rendered.content,
        isError: result.outcome !== "completed",
        metadata: {
          jobId: result.jobId,
          engine: result.engine,
          outcome: result.outcome,
          bridgeCalls: result.bridgeCalls,
          wallMs: result.wallMs,
          jobTimeoutMs,
          stdoutChars: result.stdout.length,
          stderrChars: result.stderr.length,
          ...(result.valueJson !== undefined ? { valueChars: result.valueJson.length } : {}),
          truncation: rendered.truncation,
        },
      };
    },
  };
}
