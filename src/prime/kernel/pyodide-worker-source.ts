/**
 * The worker runtime for the prime kernel's `pyodide` engine: a persistent
 * CPython interpreter re-hosting prime-agent's IPython cell semantics
 * (port-manifest §3.1) inside one dedicated module worker. Returned as
 * source text, so every value it needs (budgets, asset base) is serialized
 * into the template by the engine at construction time, exactly like
 * kernel-worker-source.ts and airship's pyodideWorkerSource
 * (src/tools/execution-tools.ts).
 *
 * Semantics and their provenance:
 *   - boot: loadPyodide from the same-origin pinned pack at
 *     /execution-packs/pyodide/; ready is posted the moment CPython
 *     has initialized, the ambient removals are applied, and the Python
 *     namespace bootstrap ran — mirroring airship's "ready the moment
 *     CPython has initialized" probe, extended with the namespace setup
 *     (the model never sees this machinery);
 *   - removals: exactly airship's nine-name list, applied ONCE after boot
 *     and before the first job. Pyodide's own loader needs fetch while
 *     booting; after boot it never does again because
 *     loadPackagesFromImports is NEVER called (pure pinned stdlib only);
 *   - persistence: one globals dict (created via pyodide.toPy({})) is
 *     reused as `globals` for every job, which gives each job's top-level
 *     assignments module-level cell semantics — the split is
 *     { globals: __globals } with `locals` defaulting to the same dict,
 *     so `x = 1` in one job is visible as `x` in the next, IPython-style.
 *     Namespace lifetime is kernel-instance-scoped: it lives and dies
 *     with this worker, and crashing it is always reported, never hidden;
 *   - streams: pyodide's batched stdout/stderr lines feed one bounded
 *     per-job capture (maxStreamChars) whose accepted delta is also
 *     live-posted in chunks of at most STREAM_CHUNK_CHARS;
 *   - values: the last-expression completion value is toJs()-converted
 *     and JSON-serialized under maxValueBytes, with the same
 *     { primeValue: "truncated", limitBytes } marker the javascript
 *     engine uses; unconvertible values fall back to String();
 *   - errors: pyodide's PythonError carries `type` (the Python exception
 *     name) and a message that *is* the formatted traceback; the worker
 *     shapes (ename, evalue, traceback) into one canonical text that
 *     always ends in the jupyter-style "<Ename>: <evalue>" tail line;
 *   - cancellation: CPython cannot be interrupted mid-statement without
 *     SharedArrayBuffer plumbing this pack does not use. Cancelling a job
 *     is therefore a cooperative flag the worker consults at every
 *     Python/JS round-trip boundary — pat.sleep polls between sleeps and
 *     pat.call refuses/resolves early — and once more when the job's
 *     runPythonAsync settles. A cancellation that lands this way is named
 *     "cancelled-with-boundary", and the hard boundary remains host-side
 *     worker termination (pyodide-engine.ts PYODIDE_TERMINATE_GRACE_MS).
 *   - one in-flight job: the host serializes the job queue (invariant 24);
 *     the worker refuses a concurrent exec closed rather than corrupting
 *     the single interpreter.
 */

import type { KernelBudgets } from "./kernel-contract";

/** Live stream frames carry at most this many characters; mirrors airship's per-frame slice rule. */
export const PYODIDE_STREAM_CHUNK_CHARS = 4_096;
/**
 * pat.sleep consults the cooperative cancel flag between polls of this
 * length. Short enough that a cancelled sleep dies promptly at a boundary,
 * long enough that the poll loop is not the hot path of the interpreter.
 */
export const PYODIDE_SLEEP_POLL_MS = 25;
/** Names token prefixing the error text of a job whose cancellation landed at a statement boundary. */
export const PYODIDE_CANCELLED_AT_BOUNDARY = "cancelled-with-boundary";
/** The preloaded Python marker naming the pat surface revision, exposed as `_pat_version`. */
export const PAT_KERNEL_VERSION = "pyodide-kernel-v1";
/** Filename shown in Python tracebacks for kernel cells (upstream shows <ipython-input-…>). */
export const PYODIDE_JOB_FILENAME = "<prime-kernel>";

/**
 * Python run once at boot inside the persistent globals dict — the minimal
 * analog of prime-agent's rlm bootstrap. Deliberately tiny and documented:
 * `pat` (the registered JS module with call/progress/sleep), `_pat_version`
 * (surface marker), and `__name__ = "__main__"` because a bare globals dict
 * otherwise resolves `__name__` to the builtins module name, while IPython
 * always runs cells as __main__.
 */
const PYTHON_NAMESPACE_BOOTSTRAP = [
  "import pat",
  `_pat_version = ${JSON.stringify(PAT_KERNEL_VERSION)}`,
  '__name__ = "__main__"',
].join("\n");

export function pyodideKernelWorkerSource(budgets: KernelBudgets, assetBase: string): string {
  return `"use strict";
const __post = globalThis.postMessage.bind(globalThis);
const __encoder = new TextEncoder();
const __budgets = ${JSON.stringify(budgets)};
const PYODIDE_MODULE = ${JSON.stringify(assetBase + "pyodide.mjs")};
const PYODIDE_BASE = ${JSON.stringify(assetBase)};
const PAT_KERNEL_VERSION = ${JSON.stringify(PAT_KERNEL_VERSION)};
const JOB_FILENAME = ${JSON.stringify(PYODIDE_JOB_FILENAME)};
const STREAM_CHUNK_CHARS = ${String(PYODIDE_STREAM_CHUNK_CHARS)};
const SLEEP_POLL_MS = ${String(PYODIDE_SLEEP_POLL_MS)};
const BOUNDARY = ${JSON.stringify(PYODIDE_CANCELLED_AT_BOUNDARY)};

let __py = undefined;
// The one persistent namespace. Created once at boot; every job receives it
// as globals (and, by default, locals), which is what makes cell state
// survive across jobs inside this worker generation.
let __globals = undefined;
// One job at a time: { jobId, seq, cancelled, cancelReason, stdout, stderr, pending: Map }.
let __active = undefined;

const __cancelError = (reason) => {
  const error = new Error(reason || "Prime kernel job cancelled.");
  error.name = "PrimeKernelJobCancelled";
  return error;
};

const __cancelText = (job) =>
  BOUNDARY + ": " + (job.cancelReason || "kernel job cancelled") +
  ". CPython cannot interrupt a statement in flight, so the cancellation landed at a Python/JS boundary (await or statement end); the hard boundary remains host-side worker termination.";

const __streamRecord = (kind, text) => {
  const job = __active;
  if (!job) return;
  // Batched pyodide lines arrive without their newline. Live frames carry
  // every line in chunks of at most STREAM_CHUNK_CHARS; the stream budget
  // binds only the durable capture (the same split the javascript engine
  // uses: page-memory presentation is never the durable authority).
  const line = String(text) + "\\n";
  for (let offset = 0; offset < line.length; offset += STREAM_CHUNK_CHARS) {
    __post({ type: kind, jobId: job.jobId, text: line.slice(offset, offset + STREAM_CHUNK_CHARS) });
  }
  if (kind === "stderr") job.stderr = (job.stderr + line).slice(0, __budgets.maxStreamChars);
  else job.stdout = (job.stdout + line).slice(0, __budgets.maxStreamChars);
};

// Value channel: identical budget rule as the javascript engine and
// airship's jsonValue — JSON text under maxValueBytes or the named
// truncation marker; anything unserializable degrades to String().
const __returnMarker = () => JSON.stringify({ primeValue: "truncated", limitBytes: __budgets.maxValueBytes });
const __serializeValueBounded = (value) => {
  let converted = value;
  try {
    if (converted && typeof converted.toJs === "function") converted = converted.toJs();
    let encoded = JSON.stringify(converted === undefined ? null : converted);
    if (encoded === undefined) encoded = "null";
    if (__encoder.encode(encoded).byteLength <= __budgets.maxValueBytes) return encoded;
    return __returnMarker();
  } catch {
    try { return JSON.stringify(String(converted)); } catch { return "\\"null\\""; }
  } finally {
    try {
      if (value && typeof value.destroy === "function" && !value.destroyed) value.destroy();
    } catch {}
  }
};

// Shape pyodide's PythonError into (ename, evalue, traceback) concatenated
// the jupyter way: the traceback body first, and a canonical
// "<Ename>: <evalue>" tail line whenever the body does not already end in
// one that names the exception.
const __pythonErrorText = (caught) => {
  let ename = "PythonError";
  if (caught && typeof caught.type === "string" && caught.type) ename = caught.type;
  else if (caught && typeof caught.name === "string" && caught.name) ename = caught.name;
  const message = String(caught && caught.message || caught || "Prime kernel job failed.");
  const body = message.replace(/[ \\t\\r\\n]+$/, "");
  const lines = body.split("\\n");
  let last = ename;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) { last = lines[i].trim(); break; }
  }
  let evalue = last;
  const parsed = last.match(/^[A-Za-z_][A-Za-z0-9_.]*(?::|[ ]*$)[ ]?(.*)$/);
  if (parsed && parsed[1] !== undefined) evalue = parsed[1].trim();
  if (!evalue) evalue = String(caught && caught.message || caught);
  if (body.indexOf(ename) >= 0 && body.endsWith(last)) return body;
  return body + "\\n" + ename + ": " + evalue;
};

// The pat module: the sanctioned egress mirroring prime-agent's typed
// host_request comm bridge. call(tool, argsJson) carries JSON text both
// ways through the host's bridge frames; progress is presentation-only
// stdout; sleep is the one cooperative cancellation point pure Python code
// can checkpoint at.
const __buildPatModule = () => ({
  call: (tool, argsJson) => new Promise((resolve, reject) => {
    const job = __active;
    if (!job) { reject(new Error("pat.call requires an active prime kernel job.")); return; }
    if (job.cancelled) { reject(__cancelError(job.cancelReason)); return; }
    const seq = job.seq++;
    if (job.seq > __budgets.maxBridgeCallsPerJob) {
      reject(new Error("Kernel bridge call limit exceeded (" + __budgets.maxBridgeCallsPerJob + " calls per job)."));
      return;
    }
    let args;
    try { args = argsJson === undefined || argsJson === null ? {} : JSON.parse(String(argsJson)); }
    catch { reject(new TypeError("pat.call arguments must be JSON text, e.g. pat.call(tool, json.dumps(obj)).")); return; }
    if (args === undefined) args = {};
    if (__encoder.encode(JSON.stringify(args)).byteLength > __budgets.maxBridgePayloadBytes) {
      reject(new Error("pat.call arguments exceed the kernel bridge payload budget (" + __budgets.maxBridgePayloadBytes + " bytes)."));
      return;
    }
    job.pending.set(seq, { resolve, reject });
    __post({ type: "bridge-request", jobId: job.jobId, call: { jobId: job.jobId, seq, tool: String(tool), arguments: args } });
  }),
  progress: (text) => __streamRecord("stdout", ":: progress: " + String(text)),
  sleep: (ms) => new Promise((resolve, reject) => {
    const total = Math.max(0, Number(ms) || 0);
    const startedAt = Date.now();
    const tick = () => {
      const job = __active;
      if (!job) { reject(new Error("Kernel job ended while pat.sleep was pending.")); return; }
      if (job.cancelled) { reject(__cancelError(job.cancelReason)); return; }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= total) { resolve(0); return; }
      setTimeout(tick, Math.min(SLEEP_POLL_MS, Math.max(1, total - elapsed)));
    };
    setTimeout(tick, Math.min(SLEEP_POLL_MS, total));
  }),
});

// CPython cannot be interrupted mid-statement; this is the entire policy,
// honestly named in the result error text when it lands.
const __requestCancel = (jobId, reason) => {
  const job = __active;
  if (!job || job.jobId !== jobId) return;
  if (job.cancelled) return;
  job.cancelled = true;
  job.cancelReason = reason;
  // Outstanding bridge awaits are Python/JS boundaries: resolve them now as
  // cancellations so the pending Python await raises promptly instead of
  // waiting on a host tool round-trip the job no longer wants.
  for (const pending of job.pending.values()) pending.reject(__cancelError(reason));
};

const __finishJob = (job, outcome, valueJson, error, startedAt) => {
  for (const pending of job.pending.values()) {
    pending.reject(new Error("Kernel job ended while a bridge call was unresolved."));
  }
  job.pending.clear();
  __active = undefined;
  __post({
    type: "finished",
    jobId: job.jobId,
    result: {
      jobId: job.jobId,
      engine: "pyodide",
      outcome,
      valueJson,
      error,
      stdout: job.stdout,
      stderr: job.stderr,
      bridgeCalls: job.seq,
      wallMs: Date.now() - startedAt
    }
  });
};

async function __runJob(spec) {
  if (__active) {
    __post({
      type: "finished",
      jobId: spec.jobId,
      result: {
        jobId: spec.jobId,
        engine: "pyodide",
        outcome: "failed",
        error: "Pyodide kernel refused a concurrent job: one in-flight cell per kernel (job " + __active.jobId + " is running).",
        stdout: "", stderr: "", bridgeCalls: 0, wallMs: 0
      }
    });
    return;
  }
  const job = {
    jobId: spec.jobId,
    seq: 0,
    cancelled: false,
    cancelReason: undefined,
    stdout: "",
    stderr: "",
    pending: new Map()
  };
  __active = job;
  const startedAt = Date.now();
  try {
    const value = await __py.runPythonAsync(String(spec.code), { globals: __globals, filename: JOB_FILENAME });
    if (job.cancelled) __finishJob(job, "cancelled", undefined, __cancelText(job), startedAt);
    else __finishJob(job, "completed", __serializeValueBounded(value), undefined, startedAt);
  } catch (caught) {
    if (job.cancelled) __finishJob(job, "cancelled", undefined, __cancelText(job), startedAt);
    else __finishJob(job, "failed", undefined, __pythonErrorText(caught), startedAt);
  }
}

globalThis.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "exec") { void __runJob(message.job); return; }
  if (message.type === "cancel") { __requestCancel(message.jobId, message.reason); return; }
  if (message.type === "bridge-response") {
    const job = __active;
    const call = message.call;
    if (!job || message.jobId !== job.jobId || !call || typeof call.seq !== "number") return;
    const pending = job.pending.get(call.seq);
    if (!pending) return;
    job.pending.delete(call.seq);
    if (call.ok) pending.resolve(call.content);
    else pending.reject(new Error(call.error || "The tool call failed."));
    return;
  }
  // The terminate frame is advisory: the host forces worker.terminate()
  // immediately after posting it, and no graceful path can outrun a
  // statement in flight anyway.
};

void (async () => {
  const bootStarted = Date.now();
  try {
    const module = await import(PYODIDE_MODULE);
    __py = await module.loadPyodide({ indexURL: PYODIDE_BASE, fullStdLib: false });
  } catch (error) {
    __post({ type: "boot-failed", engine: "pyodide", error: "Pyodide kernel boot failed: " + String(error && error.message || error) });
    return;
  }
  __py.setStdout({ batched: (line) => __streamRecord("stdout", line) });
  __py.setStderr({ batched: (line) => __streamRecord("stderr", line) });
  try { __py.setStdin({ stdin: () => null }); } catch {}
  __globals = __py.toPy({});
  // Ambient removals AFTER bootstrap, exactly airship's nine-name list,
  // applied once. Pyodide needed fetch only while booting; after this it
  // has no ambient network/storage/DOM/nested-worker egress left.
  const REMOVALS = ["fetch","XMLHttpRequest","WebSocket","EventSource","indexedDB","caches","importScripts","Worker","SharedWorker"];
  for (const name of REMOVALS) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}}
  __py.registerJsModule("pat", __buildPatModule());
  try {
    await __py.runPythonAsync(${JSON.stringify(PYTHON_NAMESPACE_BOOTSTRAP)}, { globals: __globals, filename: "<prime-kernel-init>" });
  } catch (error) {
    __post({ type: "boot-failed", engine: "pyodide", error: "Pyodide kernel namespace bootstrap failed: " + String(error && error.message || error) });
    return;
  }
  // Ready the moment CPython + namespace exist; the host now owns the clock.
  __post({
    type: "ready",
    engine: "pyodide",
    bootMs: Date.now() - bootStarted,
    version: typeof __py.version === "string" ? __py.version : "unknown"
  });
})();
`;
}
