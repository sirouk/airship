/**
 * The prime kernel contract: protocol, budgets, and capability metadata
 * for the persistent RLM execution kernel.
 *
 * Why this exists: prime-agent's RLM runs model-written code in a
 * persistent interpreter (IPython) with a namespace that survives across
 * turns and programmatic host-tool calls from inside the code. Airship's
 * execute_workspace_program approximates this shape but forces every
 * effect into a manifest of <=16 predeclared exact calls before a 10 s
 * disposable worker starts. This kernel is the same idea with the walls
 * down, and the honesty rules preserved:
 *
 *   - one persistent worker per kernel instance: a session REPL, not a
 *     disposable executor;
 *   - code runs with NO ambient network/storage/DOM (the same removal
 *     list the disposable executors use) — every effect crosses the tool
 *     bridge, where every call is individually reviewed, journaled, and
 *     approval-bound with kernel operation identity;
 *   - budgets are host policy, named here, never silently widened or
 *     hidden; the defaults below are the documented defaults;
 *   - cancellation is cooperative first (job-scope AbortSignal inside the
 *     worker) and terminate-worker as the hard boundary, reported
 *     honestly in the capability record;
 *   - namespace persistence is kernel-instance-scoped: state survives
 *     jobs and turns, and is RESET on kernel restart. Crash resets are
 *     reported, never hidden.
 */

import type { JsonValue } from "../../core/contracts";

/** Engines:// javascript is the baseline; pyodide is the true REPL analog (persistent CPython namespace). */
export type KernelEngine = "javascript" | "pyodide";

export type KernelState = "booting" | "ready" | "busy" | "draining" | "stopped" | "failed";

export type KernelJobOutcome = "completed" | "failed" | "cancelled" | "crashed";

export type KernelJobSpec = Readonly<{
  /** Optional id for tracing; generated when absent. */
  jobId?: string;
  code: string;
  /** Per-job wall-clock budget; defaults to the kernel's budget. */
  timeoutMs?: number;
  /** Optional label journaled for humans ("rlm", "skill", "tool"). */
  label?: string;
}>;

export type KernelStream = "stdout" | "stderr";

export type KernelBridgeCallRequest = Readonly<{
  jobId: string;
  seq: number;
  tool: string;
  arguments: JsonValue;
}>;

export type KernelBridgeCallResult =
  | Readonly<{ seq: number; ok: true; content: string; metadata?: JsonValue }>
  | Readonly<{ seq: number; ok: false; error: string; metadata?: JsonValue }>;

export type KernelJobEvent =
  | Readonly<{ type: "started"; jobId: string; engine: KernelEngine; label?: string }>
  | Readonly<{ type: "stdout"; jobId: string; text: string }>
  | Readonly<{ type: "stderr"; jobId: string; text: string }>
  | Readonly<{ type: "bridge-call"; jobId: string; seq: number; tool: string; arguments: JsonValue }>
  | Readonly<{ type: "bridge-result"; jobId: string; seq: number; ok: boolean }>
  | Readonly<{ type: "completed"; jobId: string; result: KernelJobResult }>
  | Readonly<{ type: "failed"; jobId: string; result: KernelJobResult }>
  | Readonly<{ type: "cancelled"; jobId: string; result: KernelJobResult }>
  | Readonly<{ type: "crashed"; jobId: string; result: KernelJobResult }>;

export type KernelJobResult = Readonly<{
  jobId: string;
  engine: KernelEngine;
  outcome: KernelJobOutcome;
  /** JSON-serialized value the job returned, or undefined for failures. */
  valueJson?: string;
  /** Human-readable error on failed/cancelled/crashed outcomes. */
  error?: string;
  /** Full captured streams (bounded by the kernel budget). */
  stdout: string;
  stderr: string;
  bridgeCalls: number;
  wallMs: number;
  bootMs?: number;
}>;

export type KernelBudgets = Readonly<{
  /** Source characters per job. Default: 256 Ki (REPL cells are larger than 64 KiB executor snippets). */
  maxSourceChars: number;
  /** Per-job wall-clock budget in ms. Default: 5 minutes. */
  maxJobWallMs: number;
  /** Per-stream capture budget per job in chars. Default: 1 Mi (page memory presentation). */
  maxStreamChars: number;
  /** Serialized return value budget in bytes. Default: 1 MiB. */
  maxValueBytes: number;
  /** Maximum tool-bridge calls per job. Default: 1000. */
  maxBridgeCallsPerJob: number;
  /** Serialized single tool-call payload budget in bytes. Default: 1 MiB. */
  maxBridgePayloadBytes: number;
  /** Jobs queued ahead of execution. Default: 64. */
  maxQueuedJobs: number;
}>;

export const DEFAULT_KERNEL_BUDGETS: KernelBudgets = Object.freeze({
  maxSourceChars: 256 * 1_024,
  maxJobWallMs: 5 * 60 * 1000,
  maxStreamChars: 1_048_576,
  maxValueBytes: 1_048_576,
  maxBridgeCallsPerJob: 1000,
  maxBridgePayloadBytes: 1_048_576,
  maxQueuedJobs: 64,
});



export type KernelHostToWorkerMessage =
  | Readonly<{ type: "init"; budgets: KernelBudgets }>
  | Readonly<{ type: "exec"; job: { jobId: string; code: string; label?: string } }>
  | Readonly<{ type: "cancel"; jobId: string; reason?: string }>
  | Readonly<{ type: "bridge-response"; jobId: string; call: KernelBridgeCallResult }>
  | Readonly<{ type: "terminate" }>;

export type KernelWorkerToHostMessage =
  | Readonly<{ type: "ready"; engine: KernelEngine }>
  | KernelJobEventMessage
  | Readonly<{ type: "bridge-request"; jobId: string; call: KernelBridgeCallRequest }>;

export type KernelJobEventMessage =
  | Readonly<{ type: "started"; jobId: string; engine: KernelEngine; label?: string }>
  | Readonly<{ type: "stdout"; jobId: string; text: string }>
  | Readonly<{ type: "stderr"; jobId: string; text: string }>
  | Readonly<{ type: "bridge-call"; jobId: string; seq: number; tool: string; arguments: JsonValue }>
  | Readonly<{ type: "bridge-result"; jobId: string; seq: number; ok: boolean }>
  | Readonly<{ type: "finished"; jobId: string; result: KernelJobResult }>;
