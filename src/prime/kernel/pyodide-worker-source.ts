/**
 * Generated runtime for the persistent Prime Pyodide kernel.
 *
 * The Pyodide loader needs the worker's normal browser surface while the
 * pinned pack boots. Immediately after loadPyodide resolves, this runtime
 * applies the canonical disposable-worker scrub to the global and every
 * recoverable WorkerGlobalScope prototype owner. The controller listener,
 * sender, protocol capability, and native collection helpers stay lexical.
 * Python receives only the frozen `pat` bridge module.
 *
 * Ambient/controller isolation does not solve cross-cell asyncio provenance:
 * an old task can call the shared module while a later cell is active. The
 * factory therefore quarantines this persistent research runtime even though
 * its direct tests continue to lock namespace and isolation behavior.
 */

import { disposableWorkerIsolationPreludeSource } from "../../execution/disposable-worker-isolation-source";
import type { KernelBudgets } from "./kernel-contract";
import {
  KERNEL_PROTOCOL_TOKEN_BYTES,
  KERNEL_STREAM_FRAME_OVERHEAD_CHARS,
  MAX_KERNEL_JOB_ID_CHARS,
  MAX_KERNEL_LABEL_CHARS,
  MAX_KERNEL_STREAM_FRAMES,
  MAX_KERNEL_TOOL_NAME_CHARS,
} from "./kernel-contract";

/** Live stream frames carry at most this many characters. */
export const PYODIDE_STREAM_CHUNK_CHARS = 4_096;
/** Cooperative sleep polling cadence. */
export const PYODIDE_SLEEP_POLL_MS = 25;
/** Named cancellation result when CPython reaches a JS boundary. */
export const PYODIDE_CANCELLED_AT_BOUNDARY = "cancelled-with-boundary";
/** Preloaded Python marker for the pat surface. */
export const PAT_KERNEL_VERSION = "pyodide-kernel-v1";
/** Filename shown in Python tracebacks. */
export const PYODIDE_JOB_FILENAME = "<prime-kernel>";
/** Exact wire revision. A fresh capability additionally binds every worker generation. */
export const PYODIDE_KERNEL_PROTOCOL_VERSION = "prime-pyodide-worker-v2";

const PYTHON_NAMESPACE_BOOTSTRAP = [
  "import pat",
  `_pat_version = ${JSON.stringify(PAT_KERNEL_VERSION)}`,
  '__name__ = "__main__"',
].join("\n");

export function pyodideKernelWorkerSource(budgets: KernelBudgets, assetBase: string): string {
  return `"use strict";
(() => {
"use strict";
${disposableWorkerIsolationPreludeSource()}
const __String = String;
const __Number = Number;
const __Error = Error;
const __TypeError = TypeError;
const __Promise = Promise;
const __Map = Map;
const __ObjectPrototype = Object.prototype;
const __objectCreate = Object.create.bind(Object);
const __objectFreeze = Object.freeze.bind(Object);
const __getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
const __reflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const __arrayIsArray = Array.isArray.bind(Array);
const __arrayIncludes = Function.call.bind(Array.prototype.includes);
const __arrayPush = Function.call.bind(Array.prototype.push);
const __arrayJoin = Function.call.bind(Array.prototype.join);
const __mapGet = Function.call.bind(Map.prototype.get);
const __mapSet = Function.call.bind(Map.prototype.set);
const __mapDelete = Function.call.bind(Map.prototype.delete);
const __mapValues = Function.call.bind(Map.prototype.values);
const __mapClear = Function.call.bind(Map.prototype.clear);
const __mapIteratorNext = Function.call.bind(
  __getPrototypeOf(__mapValues(new __Map())).next
);
const __stringSlice = Function.call.bind(String.prototype.slice);
const __stringSplit = Function.call.bind(String.prototype.split);
const __stringTrim = Function.call.bind(String.prototype.trim);
const __stringTrimEnd = Function.call.bind(String.prototype.trimEnd);
const __stringEndsWith = Function.call.bind(String.prototype.endsWith);
const __stringIndexOf = Function.call.bind(String.prototype.indexOf);
const __regexpExec = Function.call.bind(RegExp.prototype.exec);
const __regexpTest = Function.call.bind(RegExp.prototype.test);
const __jsonParse = JSON.parse.bind(JSON);
const __jsonStringify = JSON.stringify.bind(JSON);
const __encoder = new TextEncoder();
const __encode = Function.call.bind(TextEncoder.prototype.encode);
const __now = Date.now.bind(Date);
const __setTimeout = globalThis.setTimeout.bind(globalThis);
const __max = Math.max.bind(Math);
const __min = Math.min.bind(Math);
const __isFinite = Number.isFinite.bind(Number);
const __isSafeInteger = Number.isSafeInteger.bind(Number);

const __budgets = ${JSON.stringify(budgets)};
const __pyodideModule = ${JSON.stringify(assetBase + "pyodide.mjs")};
const __pyodideBase = ${JSON.stringify(assetBase)};
const __patKernelVersion = ${JSON.stringify(PAT_KERNEL_VERSION)};
const __jobFilename = ${JSON.stringify(PYODIDE_JOB_FILENAME)};
const __streamChunkChars = ${String(PYODIDE_STREAM_CHUNK_CHARS)};
const __sleepPollMs = ${String(PYODIDE_SLEEP_POLL_MS)};
const __boundary = ${JSON.stringify(PYODIDE_CANCELLED_AT_BOUNDARY)};
const __protocolVersion = ${JSON.stringify(PYODIDE_KERNEL_PROTOCOL_VERSION)};
const __protocolTokenPattern = new RegExp(${JSON.stringify(`^[0-9a-f]{${KERNEL_PROTOCOL_TOKEN_BYTES * 2}}$`)});
const __maxJobIdChars = ${String(MAX_KERNEL_JOB_ID_CHARS)};
const __maxLabelChars = ${String(MAX_KERNEL_LABEL_CHARS)};
const __maxToolNameChars = ${String(MAX_KERNEL_TOOL_NAME_CHARS)};
const __maxStreamFrames = ${String(MAX_KERNEL_STREAM_FRAMES)};
const __streamFrameOverheadChars = ${String(KERNEL_STREAM_FRAME_OVERHEAD_CHARS)};

let __protocolToken;
let __protocolGeneration;
let __resolveProtocol;
const __protocolReady = new __Promise((resolve) => { __resolveProtocol = resolve; });
let __py;
let __runPythonAsync;
let __globals;
let __active;

const __dataRecord = () => __objectCreate(null);
const __setData = (target, name, value, writable = false) => {
  __defineProperty(target, name, {
    value, enumerable: true, configurable: false, writable
  });
};

const __readRecord = (value, name, required, optional = []) => {
  if (typeof value !== "object" || value === null || __arrayIsArray(value)) {
    throw new __TypeError(name + " must be a plain record.");
  }
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = __getPrototypeOf(value);
    descriptors = __getOwnPropertyDescriptors(value);
    keys = __reflectOwnKeys(value);
  } catch {
    throw new __TypeError(name + " could not be inspected.");
  }
  if (prototype !== __ObjectPrototype && prototype !== null) {
    throw new __TypeError(name + " must have a plain-object prototype.");
  }
  const result = __dataRecord();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || (!__arrayIncludes(required, key) && !__arrayIncludes(optional, key))) {
      throw new __TypeError(name + " contains an unknown field.");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new __TypeError(name + "." + key + " must be an enumerable data property.");
    }
    __setData(result, key, descriptor.value);
  }
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (!__hasOwn(result, key)) throw new __TypeError(name + "." + key + " is required.");
  }
  return result;
};

const __requiredString = (value, name, maximum, allowEmpty = false) => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new __TypeError(name + " must be a bounded string.");
  }
  return value;
};

const __requiredSafeInteger = (value, name) => {
  if (typeof value !== "number" || !__isSafeInteger(value) || value < 0) {
    throw new __TypeError(name + " must be a non-negative safe integer.");
  }
  return value;
};

const __validateEnvelope = (record, name) => {
  if (record.protocol !== __protocolVersion
      || record.protocolToken !== __protocolToken
      || record.generation !== __protocolGeneration) {
    throw new __Error(name + " has an invalid generation capability.");
  }
};

const __postFrame = (frame) => {
  if (typeof __protocolToken !== "string" || !__isSafeInteger(__protocolGeneration)) {
    throw new __Error("The Pyodide worker protocol is not initialized.");
  }
  // Spread uses CreateDataProperty, so poisoned Object.prototype setters
  // cannot observe or replace the lexical capability.
  __post({
    ...frame,
    protocol: __protocolVersion,
    protocolToken: __protocolToken,
    generation: __protocolGeneration
  });
};

const __boundedError = (value) =>
  __stringSlice(__String(value), 0, __max(1, __budgets.maxStreamChars));

const __forEachMapValue = (map, visit) => {
  const iterator = __mapValues(map);
  for (;;) {
    const step = __mapIteratorNext(iterator);
    if (step.done) return;
    visit(step.value);
  }
};

const __protocolFault = (detail) => {
  const error = new __Error("Pyodide worker protocol violation: " + detail);
  // Throwing out of the trusted controller listener produces a Worker error;
  // the host terminates the generation. Never continue after a malformed
  // authority frame.
  throw error;
};

const __cancelError = (reason) => {
  const error = new __Error(reason || "Prime kernel job cancelled.");
  __defineProperty(error, "name", {
    value: "PrimeKernelJobCancelled", enumerable: false,
    configurable: true, writable: true
  });
  return error;
};

const __cancelText = (job) =>
  __boundary + ": " + (job.cancelReason || "kernel job cancelled")
  + ". CPython cannot interrupt a statement in flight, so the cancellation landed at a Python/JS boundary (await or statement end); the hard boundary remains host-side worker termination.";

const __streamRecord = (kind, value) => {
  const job = __active;
  if (!job || (kind !== "stdout" && kind !== "stderr")) return;
  const line = __String(value) + "\\n";
  for (let offset = 0; offset < line.length && job.streamFrames < __maxStreamFrames; offset += __streamChunkChars) {
    const chunk = __stringSlice(line, offset, offset + __streamChunkChars);
    const chargeName = kind === "stderr" ? "stderrCharge" : "stdoutCharge";
    const currentCharge = job[chargeName];
    const remaining = __budgets.maxStreamChars - currentCharge;
    if (remaining < __streamFrameOverheadChars) return;
    const accepted = __stringSlice(chunk, 0, __max(0, remaining - __streamFrameOverheadChars));
    if (accepted.length === 0 && chunk.length !== 0) return;
    job[chargeName] = currentCharge + accepted.length + __streamFrameOverheadChars;
    job.streamFrames += 1;
    if (kind === "stderr") job.stderr += accepted;
    else job.stdout += accepted;
    __postFrame({ type: kind, jobId: job.jobId, text: accepted });
  }
};

const __truncationMarker = (() => {
  const marker = __dataRecord();
  __setData(marker, "primeValue", "truncated");
  __setData(marker, "limitBytes", __budgets.maxValueBytes);
  return __jsonStringify(marker);
})();
const __returnMarker = () => __truncationMarker;

const __serializeValueBounded = (value) => {
  let converted = value;
  try {
    if (converted && typeof converted.toJs === "function") converted = converted.toJs();
    let encoded = __jsonStringify(converted === undefined ? null : converted);
    if (encoded === undefined) encoded = "null";
    if (__encode(__encoder, encoded).byteLength <= __budgets.maxValueBytes) return encoded;
    return __returnMarker();
  } catch {
    try {
      const fallback = __jsonStringify(__String(converted));
      if (__encode(__encoder, fallback).byteLength <= __budgets.maxValueBytes) return fallback;
      return __returnMarker();
    } catch { return "\\\"null\\\""; }
  } finally {
    try {
      if (value && typeof value.destroy === "function" && !value.destroyed) value.destroy();
    } catch {}
  }
};

const __pythonErrorText = (caught) => {
  let ename = "PythonError";
  if (caught && typeof caught.type === "string" && caught.type) ename = caught.type;
  else if (caught && typeof caught.name === "string" && caught.name) ename = caught.name;
  const message = __String(caught && caught.message || caught || "Prime kernel job failed.");
  const body = __stringTrimEnd(message);
  const lines = __stringSplit(body, "\\n");
  let last = ename;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = __stringTrim(lines[index]);
    if (trimmed) { last = trimmed; break; }
  }
  let evalue = last;
  const parsed = __regexpExec(/^[A-Za-z_][A-Za-z0-9_.]*(?::|[ ]*$)[ ]?(.*)$/, last);
  if (parsed && parsed[1] !== undefined) evalue = __stringTrim(parsed[1]);
  if (!evalue) evalue = __String(caught && caught.message || caught);
  if (__stringIndexOf(body, ename) >= 0 && __stringEndsWith(body, last)) return __boundedError(body);
  return __boundedError(body + "\\n" + ename + ": " + evalue);
};

const __buildPatModule = () => {
  const module = __dataRecord();
  __setData(module, "call", (toolValue, argsJson) => new __Promise((resolve, reject) => {
    const job = __active;
    if (!job) { reject(new __Error("pat.call requires an active prime kernel job.")); return; }
    if (job.cancelled) { reject(__cancelError(job.cancelReason)); return; }
    const tool = __String(toolValue);
    if (tool.length === 0 || tool.length > __maxToolNameChars) {
      reject(new __TypeError("Tool names must contain 1-" + __maxToolNameChars + " characters."));
      return;
    }
    if (job.seq >= __budgets.maxBridgeCallsPerJob) {
      reject(new __Error("Kernel bridge call limit exceeded (" + __budgets.maxBridgeCallsPerJob + " calls per job)."));
      return;
    }
    let args;
    try { args = argsJson === undefined || argsJson === null ? {} : __jsonParse(__String(argsJson)); }
    catch {
      reject(new __TypeError("pat.call arguments must be JSON text, e.g. pat.call(tool, json.dumps(obj))."));
      return;
    }
    if (args === undefined) args = {};
    let encoded;
    try { encoded = __jsonStringify(args); }
    catch { reject(new __TypeError("pat.call arguments must be JSON data.")); return; }
    if (encoded === undefined || __encode(__encoder, encoded).byteLength > __budgets.maxBridgePayloadBytes) {
      reject(new __Error("pat.call arguments exceed the kernel bridge payload budget (" + __budgets.maxBridgePayloadBytes + " bytes)."));
      return;
    }
    const seq = job.seq;
    job.seq += 1;
    __mapSet(job.pending, seq, __objectFreeze({ resolve, reject }));
    __postFrame({
      type: "bridge-request",
      jobId: job.jobId,
      call: { jobId: job.jobId, seq, tool, arguments: args }
    });
  }));
  __setData(module, "progress", (text) => __streamRecord("stdout", ":: progress: " + __String(text)));
  __setData(module, "sleep", (milliseconds) => new __Promise((resolve, reject) => {
    const total = __max(0, __Number(milliseconds) || 0);
    const startedAt = __now();
    const tick = () => {
      const job = __active;
      if (!job) { reject(new __Error("Kernel job ended while pat.sleep was pending.")); return; }
      if (job.cancelled) { reject(__cancelError(job.cancelReason)); return; }
      const elapsed = __now() - startedAt;
      if (elapsed >= total) { resolve(0); return; }
      __setTimeout(tick, __min(__sleepPollMs, __max(1, total - elapsed)));
    };
    __setTimeout(tick, __min(__sleepPollMs, total));
  }));
  return __objectFreeze(module);
};

const __requestCancel = (jobId, reason) => {
  const job = __active;
  if (!job || job.jobId !== jobId || job.cancelled) return;
  job.cancelled = true;
  job.cancelReason = reason;
  __forEachMapValue(job.pending, (pending) => pending.reject(__cancelError(reason)));
};

const __finishJob = (job, outcome, valueJson, error, startedAt) => {
  __forEachMapValue(job.pending, (pending) => {
    pending.reject(new __Error("Kernel job ended while a bridge call was unresolved."));
  });
  __mapClear(job.pending);
  __active = undefined;
  __postFrame({
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
      wallMs: __max(0, __now() - startedAt)
    }
  });
};

async function __runJob(spec) {
  if (__active) return __protocolFault("the host sent concurrent exec frames");
  const job = __dataRecord();
  __setData(job, "jobId", spec.jobId);
  __setData(job, "seq", 0, true);
  __setData(job, "cancelled", false, true);
  __setData(job, "cancelReason", undefined, true);
  __setData(job, "stdout", "", true);
  __setData(job, "stderr", "", true);
  __setData(job, "stdoutCharge", 0, true);
  __setData(job, "stderrCharge", 0, true);
  __setData(job, "streamFrames", 0, true);
  __setData(job, "pending", new __Map());
  __active = job;
  const startedAt = __now();
  try {
    const value = await __runPythonAsync(__String(spec.code), {
      globals: __globals,
      filename: __jobFilename
    });
    if (job.cancelled) __finishJob(job, "cancelled", undefined, __cancelText(job), startedAt);
    else __finishJob(job, "completed", __serializeValueBounded(value), undefined, startedAt);
  } catch (caught) {
    if (job.cancelled) __finishJob(job, "cancelled", undefined, __cancelText(job), startedAt);
    else __finishJob(job, "failed", undefined, __pythonErrorText(caught), startedAt);
  }
}

const __readAuthenticatedMessage = (value) => {
  const head = __readRecord(
    value,
    "controller frame",
    ["type", "protocol", "protocolToken", "generation"],
    ["job", "jobId", "reason", "call"]
  );
  __validateEnvelope(head, "controller frame");
  return head;
};

const __onControllerMessage = (event) => {
  // Only browser-delivered Worker messages are authority. Model code can
  // construct MessageEvent objects, but those always carry isTrusted=false.
  if (!event || event.isTrusted !== true) return;
  try {
    if (__protocolToken === undefined) {
      const init = __readRecord(
        event.data,
        "init frame",
        ["type", "protocol", "protocolToken", "generation"]
      );
      if (init.type !== "init" || init.protocol !== __protocolVersion
          || typeof init.protocolToken !== "string"
          || !__regexpTest(__protocolTokenPattern, init.protocolToken)
          || !__isSafeInteger(init.generation) || init.generation < 0) {
        return __protocolFault("the initialization frame is invalid");
      }
      __protocolToken = init.protocolToken;
      __protocolGeneration = init.generation;
      const resolve = __resolveProtocol;
      __resolveProtocol = undefined;
      resolve();
      return;
    }

    const message = __readAuthenticatedMessage(event.data);
    if (message.type === "exec") {
      const spec = __readRecord(message.job, "exec frame.job", ["jobId", "code"], ["label"]);
      __requiredString(spec.jobId, "exec frame.job.jobId", __maxJobIdChars);
      __requiredString(spec.code, "exec frame.job.code", __budgets.maxSourceChars, true);
      if (spec.label !== undefined) __requiredString(spec.label, "exec frame.job.label", __maxLabelChars, true);
      void __runJob(spec);
      return;
    }
    if (message.type === "cancel") {
      const jobId = __requiredString(message.jobId, "cancel frame.jobId", __maxJobIdChars);
      if (message.reason !== undefined) __requiredString(message.reason, "cancel frame.reason", __budgets.maxStreamChars, true);
      __requestCancel(jobId, message.reason);
      return;
    }
    if (message.type === "bridge-response") {
      const jobId = __requiredString(message.jobId, "bridge-response frame.jobId", __maxJobIdChars);
      const call = __readRecord(message.call, "bridge-response frame.call", ["seq", "ok"], ["content", "error", "metadata"]);
      const seq = __requiredSafeInteger(call.seq, "bridge-response frame.call.seq");
      if (call.ok !== true && call.ok !== false) return __protocolFault("bridge-response ok is not boolean");
      const job = __active;
      if (!job || jobId !== job.jobId) return;
      const pending = __mapGet(job.pending, seq);
      if (!pending) return;
      __mapDelete(job.pending, seq);
      if (call.ok === true) {
        const content = __requiredString(call.content, "bridge-response frame.call.content", __budgets.maxBridgePayloadBytes, true);
        pending.resolve(content);
      } else {
        const error = __requiredString(call.error, "bridge-response frame.call.error", __budgets.maxBridgePayloadBytes);
        pending.reject(new __Error(error));
      }
      return;
    }
    if (message.type === "terminate") return;
    return __protocolFault("the host sent an unknown frame type");
  } catch (caught) {
    return __protocolFault(__boundedError(caught && caught.message || caught));
  }
};

// Install the only controller listener while the native EventTarget method is
// still available. It remains reachable only from this closure after scrub.
__listen("message", __onControllerMessage);

void (async () => {
  await __protocolReady;
  const bootStarted = __now();
  try {
    const module = await import(__pyodideModule);
    __py = await module.loadPyodide({ indexURL: __pyodideBase, fullStdLib: false });

    // This must be the first action after the pinned loader resolves. Pyodide
    // needed fetch/XHR to boot; namespace setup and every model cell run only
    // after the canonical ambient + controller prototype scrub succeeds.
    __scrubAmbient();
    __scrubController();
  } catch (caught) {
    __postFrame({
      type: "boot-failed",
      engine: "pyodide",
      error: "Pyodide kernel boot/isolation failed: " + __boundedError(caught && caught.message || caught)
    });
    return;
  }

  try {
    __py.setStdout({ batched: (line) => __streamRecord("stdout", line) });
    __py.setStderr({ batched: (line) => __streamRecord("stderr", line) });
    try { __py.setStdin({ stdin: () => null }); } catch {}
    __globals = __py.toPy({});
    __py.registerJsModule("pat", __buildPatModule());
    // Bind the later-used entry point before Python can import pyodide_js and
    // replace properties on the shared public API object.
    __runPythonAsync = __py.runPythonAsync.bind(__py);
    await __runPythonAsync(${JSON.stringify(PYTHON_NAMESPACE_BOOTSTRAP)}, {
      globals: __globals,
      filename: "<prime-kernel-init>"
    });
  } catch (caught) {
    __postFrame({
      type: "boot-failed",
      engine: "pyodide",
      error: "Pyodide kernel namespace bootstrap failed: " + __boundedError(caught && caught.message || caught)
    });
    return;
  }

  __postFrame({
    type: "ready",
    engine: "pyodide",
    bootMs: __max(0, __now() - bootStarted),
    version: typeof __py.version === "string" ? __py.version : "unknown"
  });
})();
})();
`;
}
