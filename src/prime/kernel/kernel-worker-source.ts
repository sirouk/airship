/**
 * The worker runtime for the prime kernel's `javascript` engine. Returned
 * as source text (airship pattern: execution-tools.ts workerSource), so
 * every value it needs is serialized into the template by the host at
 * construction time.
 *
 * Inside the worker:
 *   - ambient network/storage/DOM/nested-worker surfaces are removed,
 *     identical to the airship disposable-executor removal list; the tool
 *     bridge (pat.call) is the sanctioned egress;
 *   - one shared REPL namespace survives across jobs in THIS worker: job
 *     code receives namespace keys as locals and pat.ns as the shared
 *     mutable namespace object;
 *   - streaming goes through bounded chunks; the host owns durable
 *     capture and results;
 *   - cancellation is a job-scope AbortSignal first, worker termination
 *     the hard boundary; bridge calls and sleeps honor the signal;
 *   - the value channel is one serialized, budget-checked JSON text.
 */

import type { KernelBudgets } from "./kernel-contract";

export function kernelWorkerSource(budgets: KernelBudgets): string {
  return `"use strict";
const __post = globalThis.postMessage.bind(globalThis);
const __budgets = ${JSON.stringify(budgets)};

const ns = {};
const jobs = new Map();
const pendingCalls = new Map();

const __emit = (jobId, type, text) => __post({ type, jobId, text });

const __render = (v) => {
  try { return typeof v === "string" ? v : JSON.stringify(v); }
  catch { return String(v); }
};

const __serializeValueBounded = (value) => {
  let encoded;
  try { encoded = JSON.stringify(value === undefined ? null : value); }
  catch { encoded = JSON.stringify(String(value)); }
  if (encoded === undefined) encoded = "null";
  if (new TextEncoder().encode(encoded).byteLength <= __budgets.maxValueBytes) return encoded;
  return JSON.stringify({ primeValue: "truncated", limitBytes: __budgets.maxValueBytes });
};

const REMOVALS = ["fetch","XMLHttpRequest","WebSocket","EventSource","indexedDB","caches","importScripts","Worker","SharedWorker"];
for (const name of REMOVALS) {
  try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}}

const __abortError = (reason) => {
  const error = new Error(reason || "Kernel job cancelled.");
  error.name = "KernelAbortError";
  return error;
};

const __bridgeCall = (job, seqCounter, tool, args) => new Promise((resolve, reject) => {
  if (job.abort.signal.aborted) { reject(__abortError()); return; }
  const entry = pendingCalls.get(job.jobId);
  if (!entry) { reject(new Error("Kernel job registry lost pending bridge calls.")); return; }
  const seq = seqCounter.next++;
  if (seq >= __budgets.maxBridgeCallsPerJob) {
    reject(new Error("Kernel bridge call limit exceeded (" + __budgets.maxBridgeCallsPerJob + " calls per job)."));
    return;
  }
  let payload;
  try { payload = JSON.stringify(args === undefined ? {} : args); }
  catch { reject(new TypeError("Tool arguments must be JSON-serializable.")); return; }
  if (payload === undefined) payload = "null";
  if (new TextEncoder().encode(payload).byteLength > __budgets.maxBridgePayloadBytes) {
    reject(new Error("Tool arguments exceed the kernel bridge payload budget."));
    return;
  }
  entry.set(seq, { resolve, reject });
  __post({ type: "bridge-request", jobId: job.jobId, call: { jobId: job.jobId, seq, tool, arguments: JSON.parse(payload) } });
});

globalThis.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "exec") { void __runJob(message.job); return; }
  if (message.type === "cancel") {
    const job = jobs.get(message.jobId);
    if (job) job.abort.abort(__abortError(message.reason));
    return;
  }
  if (message.type === "bridge-response") {
    const entry = pendingCalls.get(message.jobId);
    if (!entry) return;
    const call = message.call;
    if (!call || typeof call.seq !== "number") return;
    const pending = entry.get(call.seq);
    if (!pending) return;
    entry.delete(call.seq);
    if (call.ok) pending.resolve(call);
    else pending.reject(new Error(call.error || "The tool call failed."));
  }
};

async function __runJob(job) {
  const abort = new AbortController();
  jobs.set(job.jobId, { abort });
  pendingCalls.set(job.jobId, new Map());
  const seqCounter = { next: 0 };
  const stdout = [];
  const stderr = [];
  let streamCharsStdout = 0;
  let streamCharsStderr = 0;

  const streamRecord = (type, text) => {
    if (type === "stderr") {
      streamCharsStderr += text.length;
      if (streamCharsStderr <= __budgets.maxStreamChars) stderr.push(text);
    } else {
      streamCharsStdout += text.length;
      if (streamCharsStdout <= __budgets.maxStreamChars) stdout.push(text);
    }
    __emit(job.jobId, type, text);
  };

  const toolkit = {
    print: (...values) => streamRecord("stdout", values.map(__render).join(" ")),
    printerr: (...values) => streamRecord("stderr", values.map(__render).join(" ")),
    sleep: (ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      abort.signal.addEventListener("abort", () => { clearTimeout(timer); reject(__abortError()); }, { once: true });
    }),
    call: (tool, args) => __bridgeCall({ jobId: job.jobId, abort }, seqCounter, String(tool), args),
    progress: (text) => streamRecord("stdout", ":: progress: " + String(text)),
    ns,
    signal: abort.signal,
  };

  let valueJson;
  let error;
  let outcome = "completed";
  const startedAt = Date.now();
  try {
    // The toolkit parameter carries the name the model was given, not an
    // implementation name: the system prompt, the execute_code description and
    // the pyodide engine all say pat.call, so binding it to anything else makes
    // the kernel's only sanctioned egress a ReferenceError for every model that
    // believes its own prompt. Namespace keys are filtered against both
    // injected names because a duplicate parameter in a strict-mode
    // AsyncFunction is a SyntaxError, not a shadowing.
    const keys = Object.keys(ns).filter((k) => k !== "pat" && k !== "__job").sort();
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const argNames = keys.concat(["__job", "pat"]);
    const argValues = keys.map((k) => ns[k]).concat([{ jobId: job.jobId, label: job.label }, toolkit]);
    // Single quotes on purpose: this line is generated source, so a
    // double-quoted literal here needs an escape that the template renders
    // away, and the emitted worker read an empty string followed by a bare
    // identifier (use), which made the whole worker script a
    // SyntaxError that no unit test could see because none of them ran the
    // generated text.
    const fn = AsyncFunction.apply(null, argNames.concat(['"use strict";\\n' + job.code + '\\n']));
    const value = await fn.apply(undefined, argValues);
    valueJson = __serializeValueBounded(value);
  } catch (caught) {
    if (abort.signal.aborted || (caught && caught.name === "KernelAbortError")) {
      outcome = "cancelled";
      error = String(caught && caught.message || caught || "Kernel job cancelled.");
    } else {
      outcome = "failed";
      error = String(caught && caught.stack || caught);
    }
  }
  const wallMs = Date.now() - startedAt;

  const pendings = pendingCalls.get(job.jobId);
  if (pendings) for (const pending of pendings.values()) pending.reject(__abortError("Kernel job ended while a bridge call was unresolved."));
  pendingCalls.delete(job.jobId);
  jobs.delete(job.jobId);

  __post({
    type: "finished",
    jobId: job.jobId,
    result: {
      jobId: job.jobId,
      engine: "javascript",
      outcome,
      valueJson,
      error,
      stdout: stdout.join('\\n'),
      stderr: stderr.join('\\n'),
      bridgeCalls: seqCounter.next,
      wallMs
    }
  });
}

__post({ type: "ready", engine: "javascript" });
`;
}

