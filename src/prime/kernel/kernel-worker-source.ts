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
 *   - one job-scoped namespace exists inside this disposable worker: job
 *     code receives pat.ns as its mutable namespace object, but the host
 *     terminates this worker after the finished frame;
 *   - streaming goes through bounded chunks; the host owns durable
 *     capture and results;
 *   - cancellation is a job-scope AbortSignal first, worker termination
 *     the hard boundary; bridge calls and sleeps honor the signal;
 *   - the value channel is one serialized, budget-checked JSON text.
 */

import {
  DISPOSABLE_WORKER_AMBIENT_GLOBALS,
  DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
  DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
} from "../../execution/disposable-worker-isolation-source";
import type { KernelBudgets } from "./kernel-contract";
import {
  KERNEL_PROTOCOL_TOKEN_BYTES,
  KERNEL_STREAM_FRAME_OVERHEAD_CHARS,
  MAX_KERNEL_STREAM_FRAMES,
  MAX_KERNEL_TOOL_NAME_CHARS,
} from "./kernel-contract";

/** Mint a generation-local capability. Production callers must never reuse it. */
export function createKernelProtocolToken(): string {
  const cryptography = globalThis.crypto;
  if (!cryptography || typeof cryptography.getRandomValues !== "function") {
    throw new Error("The prime kernel requires crypto.getRandomValues for its worker protocol capability.");
  }
  const bytes = new Uint8Array(KERNEL_PROTOCOL_TOKEN_BYTES);
  cryptography.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function kernelWorkerSource(
  budgets: KernelBudgets,
  protocolToken: string = createKernelProtocolToken(),
): string {
  if (!new RegExp(`^[0-9a-f]{${KERNEL_PROTOCOL_TOKEN_BYTES * 2}}$`).test(protocolToken)) {
    throw new TypeError("Kernel protocol tokens must be 32 random bytes encoded as lowercase hex.");
  }

  return `"use strict";
(() => {
"use strict";
const __controllerGlobal = globalThis;
const __post = globalThis.postMessage.bind(globalThis);
const __listen = globalThis.addEventListener.bind(globalThis);
const __defineProperty = Object.defineProperty;
const __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const __getPrototypeOf = Object.getPrototypeOf;
const __reflectApply = Reflect.apply.bind(Reflect);
const __objectKeys = Object.keys;
const __assign = Object.assign;
const __hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
const __String = String;
const __Number = Number;
const __Error = Error;
const __TypeError = TypeError;
const __Promise = Promise;
const __Map = Map;
const __mapGet = Function.call.bind(Map.prototype.get);
const __mapSet = Function.call.bind(Map.prototype.set);
const __mapDelete = Function.call.bind(Map.prototype.delete);
const __mapValues = Function.call.bind(Map.prototype.values);
const __arrayPush = Function.call.bind(Array.prototype.push);
const __arrayJoin = Function.call.bind(Array.prototype.join);
const __AbortController = AbortController;
const __max = Math.max.bind(Math);
const __setTimeout = globalThis.setTimeout.bind(globalThis);
const __clearTimeout = globalThis.clearTimeout.bind(globalThis);
const __jsonStringify = JSON.stringify.bind(JSON);
const __jsonParse = JSON.parse.bind(JSON);
const __encoder = new TextEncoder();
const __now = Date.now.bind(Date);
const __AsyncFunction = __getPrototypeOf(async function(){}).constructor;
const __protocolToken = ${JSON.stringify(protocolToken)};
const __budgets = ${JSON.stringify(budgets)};
const __maxStreamFrames = ${String(MAX_KERNEL_STREAM_FRAMES)};
const __streamFrameOverheadChars = ${String(KERNEL_STREAM_FRAME_OVERHEAD_CHARS)};
const __maxToolNameChars = ${String(MAX_KERNEL_TOOL_NAME_CHARS)};

const ns = {};
const jobs = new __Map();
const pendingCalls = new __Map();

// Only this closure owns the native sender and the generation capability.
// Object spread uses CreateDataProperty, so a model-installed prototype setter
// cannot observe or replace the token while a frame is assembled.
const __postFrame = (frame) => __post({ ...frame, protocolToken: __protocolToken });
const __emit = (jobId, type, text) => __postFrame({ type, jobId, text });

const __render = (v) => {
  try { return typeof v === "string" ? v : __jsonStringify(v); }
  catch { return __String(v); }
};

const __serializeValueBounded = (value) => {
  let encoded;
  try { encoded = __jsonStringify(value === undefined ? null : value); }
  catch { encoded = __jsonStringify(__String(value)); }
  if (encoded === undefined) encoded = "null";
  if (__encoder.encode(encoded).byteLength <= __budgets.maxValueBytes) return encoded;
  return __jsonStringify({ primeValue: "truncated", limitBytes: __budgets.maxValueBytes });
};

const __scrubGlobalName = (name) => {
  // Own shadow first, then every owner in the WorkerGlobalScope prototype
  // chain. A cell that walks prototypes must not recover an ambient channel.
  try { __defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
  let target = __getPrototypeOf(globalThis);
  while (target) {
    try {
      if (__hasOwn(target, name)) {
        __defineProperty(target, name, { value: undefined, configurable: false, writable: false });
      }
    } catch {}
    target = __getPrototypeOf(target);
  }
  target = globalThis;
  while (target) {
    const descriptor = __getOwnPropertyDescriptor(target, name);
    if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
      throw new __Error("Kernel isolation could not hide " + name + ".");
    }
    target = __getPrototypeOf(target);
  }
};

const REMOVALS = ${JSON.stringify(DISPOSABLE_WORKER_AMBIENT_GLOBALS)};
for (const name of REMOVALS) __scrubGlobalName(name);

const __abortError = (reason) => {
  const error = new Error(reason || "Kernel job cancelled.");
  error.name = "KernelAbortError";
  return error;
};

const __bridgeCall = (job, seqCounter, tool, args) => new __Promise((resolve, reject) => {
  if (job.abort.signal.aborted) { reject(__abortError()); return; }
  const entry = __mapGet(pendingCalls, job.jobId);
  if (!entry) { reject(new Error("Kernel job registry lost pending bridge calls.")); return; }
  if (seqCounter.next >= __budgets.maxBridgeCallsPerJob) {
    reject(new Error("Kernel bridge call limit exceeded (" + __budgets.maxBridgeCallsPerJob + " calls per job)."));
    return;
  }
  if (typeof tool !== "string" || tool.length === 0 || tool.length > __maxToolNameChars) {
    reject(new TypeError("Tool names must contain 1-" + __maxToolNameChars + " characters."));
    return;
  }
  let payload;
  try { payload = __jsonStringify(args === undefined ? {} : args); }
  catch { reject(new TypeError("Tool arguments must be JSON-serializable.")); return; }
  if (payload === undefined) payload = "null";
  if (__encoder.encode(payload).byteLength > __budgets.maxBridgePayloadBytes) {
    reject(new Error("Tool arguments exceed the kernel bridge payload budget."));
    return;
  }
  const seq = seqCounter.next;
  seqCounter.next += 1;
  __mapSet(entry, seq, { resolve, reject });
  __postFrame({
    type: "bridge-request",
    jobId: job.jobId,
    call: { jobId: job.jobId, seq, tool, arguments: __jsonParse(payload) }
  });
});

const __onControllerMessage = (event) => {
  // Browser-delivered Worker messages are trusted. A MessageEvent dispatched
  // by evaluated code is not. The handler is lexical and onmessage itself is
  // removed below, so model code cannot call it directly either.
  if (!event || event.isTrusted !== true) return;
  const message = event.data;
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  if (message.type === "exec") { void __runJob(message.job); return; }
  if (message.type === "cancel") {
    const job = __mapGet(jobs, message.jobId);
    if (job) job.abort.abort(__abortError(message.reason));
    return;
  }
  if (message.type === "bridge-response") {
    const entry = __mapGet(pendingCalls, message.jobId);
    if (!entry) return;
    const call = message.call;
    if (!call || !__Number.isSafeInteger(call.seq) || call.seq < 0) return;
    const pending = __mapGet(entry, call.seq);
    if (!pending) return;
    __mapDelete(entry, call.seq);
    if (call.ok === true) pending.resolve(call);
    else if (call.ok === false) pending.reject(new Error(call.error || "The tool call failed."));
  }
};

__listen("message", __onControllerMessage);

// Hide the controller surface before the first cell can run. Message-specific
// methods are shadowed on every worker owner. Generic EventTarget methods must
// remain usable by AbortSignal, so replace each recoverable prototype method
// with a receiver guard: it delegates for every EventTarget except this worker
// global. This blocks EventTarget.prototype.addEventListener.call(globalThis,
// "message", ...) without disabling pat.signal or pat.sleep cancellation.
const __guardControllerReceiver = (owner, name) => {
  const descriptor = __getOwnPropertyDescriptor(owner, name);
  if (!descriptor) return;
  if (typeof descriptor.value !== "function") {
    throw new __Error("Kernel isolation could not guard controller method " + name + ".");
  }
  const nativeMethod = descriptor.value;
  __defineProperty(owner, name, {
    ...descriptor,
    configurable: false,
    writable: false,
    value: function(...args) {
      if (this === __controllerGlobal) throw new __TypeError("The kernel controller EventTarget is not exposed to job code.");
      return __reflectApply(nativeMethod, this, args);
    }
  });
};
const __eventTargetPrototype = typeof EventTarget === "function" ? EventTarget.prototype : undefined;
if (__eventTargetPrototype) {
  for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)}) {
    __guardControllerReceiver(__eventTargetPrototype, name);
  }
}
let __controllerPrototype = __getPrototypeOf(__controllerGlobal);
while (__controllerPrototype && __controllerPrototype !== __eventTargetPrototype) {
  for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)}) {
    __guardControllerReceiver(__controllerPrototype, name);
  }
  __controllerPrototype = __getPrototypeOf(__controllerPrototype);
}
for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_GLOBALS)}) {
  __scrubGlobalName(name);
}
for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)}) {
  __defineProperty(__controllerGlobal, name, { value: undefined, configurable: false, writable: false });
}

async function __runJob(job) {
  const abort = new __AbortController();
  __mapSet(jobs, job.jobId, { abort });
  __mapSet(pendingCalls, job.jobId, new __Map());
  const seqCounter = { next: 0 };
  const stdout = [];
  const stderr = [];
  let streamChargeStdout = 0;
  let streamChargeStderr = 0;
  let streamFrames = 0;

  const streamRecord = (type, value) => {
    if (streamFrames >= __maxStreamFrames) return;
    const text = __String(value);
    const currentCharge = type === "stderr" ? streamChargeStderr : streamChargeStdout;
    const remaining = __budgets.maxStreamChars - currentCharge;
    if (remaining < __streamFrameOverheadChars) return;
    const accepted = text.slice(0, __max(0, remaining - __streamFrameOverheadChars));
    if (accepted.length === 0 && text.length !== 0) return;

    const charge = accepted.length + __streamFrameOverheadChars;
    streamFrames += 1;
    if (type === "stderr") {
      streamChargeStderr += charge;
      __arrayPush(stderr, accepted);
    } else {
      streamChargeStdout += charge;
      __arrayPush(stdout, accepted);
    }
    __emit(job.jobId, type, accepted);
  };

  const toolkit = {
    print: (...values) => streamRecord("stdout", values.map(__render).join(" ")),
    printerr: (...values) => streamRecord("stderr", values.map(__render).join(" ")),
    sleep: (ms) => new __Promise((resolve, reject) => {
      const timer = __setTimeout(resolve, __max(0, __Number(ms) || 0));
      abort.signal.addEventListener("abort", () => { __clearTimeout(timer); reject(__abortError()); }, { once: true });
    }),
    call: (tool, args) => __bridgeCall({ jobId: job.jobId, abort }, seqCounter, __String(tool), args),
    progress: (text) => streamRecord("stdout", ":: progress: " + __String(text)),
    ns,
    signal: abort.signal,
  };

  /*
   * The RLM call surface: subagents as function calls, not as JSON tool calls.
   *
   * This is the difference the port exists for. prime-agent's model does not
   * emit a tool-call envelope to delegate — it writes
   * 'await rlm("do this subtask", { name: "reviewer" })' inside a kernel job
   * and gets a handle back immediately, then reads replies later. The
   * tools were registered on the host first, which made delegation reachable
   * only as 'pat.call("rlm_spawn", …)' — correct, and not the language the
   * ported system prompt teaches or the shape the model was trained into.
   *
   * Every one of these is a thin wrapper over 'pat.call', so nothing here is a
   * second egress: the same reviewed bridge, the same
   * 'prime-kernel:<jobId>:<seq>' operation identity, the same approval. Only
   * the spelling changes, and the spelling is the feature.
   */
  const __rlm = (prompt, options) => toolkit.call("rlm_spawn", __assign({ prompt: __String(prompt) }, options || {}));
  const __subagent = (action, options) => toolkit.call("subagent", __assign({ action: __String(action) }, options || {}));
  const __agentObserve = (action, options) => toolkit.call("agent_observe", __assign({ action: __String(action) }, options || {}));
  const __agentMessage = {
    // send(target, message) where target is "parent", or an object carrying
    // id or name for a sibling or child — the three the router admits.
    send: (target, message) => {
      const envelope = { action: "send", message: __String(message) };
      if (typeof target === "string") envelope.receiver_role = target;
      else if (target && typeof target === "object") {
        if (target.role) envelope.receiver_role = __String(target.role);
        if (target.id) envelope.receiver_id = __String(target.id);
        if (target.name) envelope.receiver_name = __String(target.name);
      }
      return toolkit.call("agent_message", envelope);
    },
    list_agents: () => toolkit.call("agent_message", { action: "list_agents" }),
  };
  const __harness = (action, options) => toolkit.call("prime_harness", __assign({ action: __String(action) }, options || {}));
  const __heartbeat = (action, options) => toolkit.call("rlm_heartbeat", __assign({ action: __String(action) }, options || {}));

  let valueJson;
  let error;
  let outcome = "completed";
  const startedAt = __now();
  try {
    // The toolkit parameter carries the name the model was given, not an
    // implementation name: the system prompt, the execute_code description and
    // the pyodide engine all say pat.call, so binding it to anything else makes
    // the kernel's only sanctioned egress a ReferenceError for every model that
    // believes its own prompt. Namespace keys are filtered against both
    // injected names because a duplicate parameter in a strict-mode
    // AsyncFunction is a SyntaxError, not a shadowing.
    // The RLM names are injected beside 'pat' for the same reason 'pat' is:
    // they are the vocabulary the prompt teaches, and a namespace key of the
    // same name would be a duplicate parameter — a SyntaxError in a
    // strict-mode AsyncFunction, not a shadowing. A user who assigns
    // 'ns.rlm = …' keeps their value; the injected binding simply is not
    // offered twice.
    const __injected = ["pat", "__job", "rlm", "subagent", "agent_message", "agent_observe", "harness", "heartbeat"];
    const keys = __objectKeys(ns).filter((k) => __injected.indexOf(k) === -1).sort();
    const AsyncFunction = __AsyncFunction;
    const argNames = keys.concat([
      "__job", "pat", "rlm", "subagent", "agent_message", "agent_observe", "harness", "heartbeat",
    ]);
    const argValues = keys.map((k) => ns[k]).concat([
      { jobId: job.jobId, label: job.label }, toolkit,
      __rlm, __subagent, __agentMessage, __agentObserve, __harness, __heartbeat,
    ]);
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
      error = __String(caught && caught.message || caught || "Kernel job cancelled.").slice(0, __budgets.maxStreamChars);
    } else {
      outcome = "failed";
      error = __String(caught && caught.stack || caught).slice(0, __budgets.maxStreamChars);
    }
  }
  const wallMs = __max(0, __now() - startedAt);

  const pendings = __mapGet(pendingCalls, job.jobId);
  if (pendings) for (const pending of __mapValues(pendings)) pending.reject(__abortError("Kernel job ended while a bridge call was unresolved."));
  __mapDelete(pendingCalls, job.jobId);
  __mapDelete(jobs, job.jobId);

  __postFrame({
    type: "finished",
    jobId: job.jobId,
    result: {
      jobId: job.jobId,
      engine: "javascript",
      outcome,
      valueJson,
      error,
      stdout: __arrayJoin(stdout, '\\n'),
      stderr: __arrayJoin(stderr, '\\n'),
      bridgeCalls: seqCounter.next,
      wallMs
    }
  });
}

__postFrame({ type: "ready", engine: "javascript" });
})();
`;
}

