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
  /*
   * bootMs/version are additive and pyodide-only: the javascript worker
   * boots synchronously into ready, while the pyodide worker reports the
   * CPython cold-start cost and the pack version right on the ready frame
   * so the host can stamp bootMs onto the generation's first job result
   * and fail closed on an asset/pin mismatch. boot-failed is the pyodide
   * worker's honest "interpreter never came up" frame; the javascript
   * worker has no such path because its boot cannot await anything.
   */
  | Readonly<{ type: "ready"; engine: KernelEngine; bootMs?: number; version?: string }>
  | Readonly<{ type: "boot-failed"; engine: KernelEngine; error: string }>
  | KernelJobEventMessage
  | Readonly<{ type: "bridge-request"; jobId: string; call: KernelBridgeCallRequest }>;

export type KernelJobEventMessage =
  | Readonly<{ type: "started"; jobId: string; engine: KernelEngine; label?: string }>
  | Readonly<{ type: "stdout"; jobId: string; text: string }>
  | Readonly<{ type: "stderr"; jobId: string; text: string }>
  | Readonly<{ type: "bridge-call"; jobId: string; seq: number; tool: string; arguments: JsonValue }>
  | Readonly<{ type: "bridge-result"; jobId: string; seq: number; ok: boolean }>
  | Readonly<{ type: "finished"; jobId: string; result: KernelJobResult }>;

/**
 * Honest capability metadata one engine instance reports about itself, in
 * the same vocabulary airship's execution runtime registry uses
 * (src/execution/runtime-registry.ts): what persists, what a workspace can
 * be, how a job dies, and what egress exists. No field here is marketing:
 * every value is named so a caller can reason about the wall it will hit.
 */
export type KernelEngineDescription = Readonly<{
  state: KernelState;
  engine: KernelEngine;
  /** Worker generation: increments exactly when the namespace was reset. */
  generation: number;
  queuedJobs: number;
  /** Cold-start cost of the current worker generation, when known. */
  bootMs?: number;
  /** Pinned engine/runtime version the host expects (pyodide pack pin). */
  version?: string;
  /** Version the live worker actually reported on its ready frame. */
  runtimeVersion?: string;
  /**
   * What kernel code can do to a workspace directly. "none" is the truth
   * for both engines today: there is no mount, every file effect crosses
   * the reviewed tool bridge. "bridge-documented" is reserved for a future
   * engine whose bridge carries workspace verbs.
   */
  workspaceAccess: "none" | "bridge-documented";
  /**
   * Namespace lifetime. Both engines are "kernel-instance": top-level
   * assignments survive across jobs inside one worker generation and are
   * destroyed — and reported as destroyed — by restart, crash, or
   * terminate. Cross-restart snapshots (prime-agent's dill state-snapshot)
   * are explicitly NOT claimed here; see pyodide PORT.md for the deferred
   * restore seam.
   */
  persistence: "kernel-instance";
  /**
   * Cancellation truth per engine: javascript aborts its job-scope
   * AbortSignal first; pyodide flips a cooperative flag CPython consults
   * at statement/await boundaries; both terminate the worker as the hard
   * boundary.
   */
  cancellation: "abort-signal-then-terminate-worker" | "cooperative-then-terminate-worker" | "terminate-worker";
  /**
   * Egress truth: the ambient surface removal list is applied, so the only
   * egress is the reviewed tool bridge. Named, never implied.
   */
  network: "absent-ambient; tool bridge only";
}>;
