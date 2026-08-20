/**
 * Canonical ambient and controller isolation emitted into disposable browser
 * workers before model-written code can run. These workers inherit the page's
 * broad provider `connect-src`, so every recoverable WorkerGlobalScope owner
 * must be removed, not only shadowed on `globalThis`.
 */
export const DISPOSABLE_WORKER_AMBIENT_GLOBALS = Object.freeze([
  "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource",
  "indexedDB", "caches", "localStorage", "sessionStorage", "cookieStore",
  "navigator", "importScripts", "Worker", "SharedWorker", "BroadcastChannel",
  "FontFace", "fonts", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "Notification",
  "webkitRequestFileSystem", "webkitRequestFileSystemSync",
  "webkitResolveLocalFileSystemURL", "webkitResolveLocalFileSystemSyncURL",
] as const);

export const DISPOSABLE_WORKER_CONTROLLER_GLOBALS = Object.freeze([
  "postMessage", "onmessage", "onmessageerror", "close",
] as const);

export const DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS = Object.freeze([
  "addEventListener", "removeEventListener", "dispatchEvent",
] as const);

/**
 * Return declarations for an enclosing worker IIFE. The caller captures any
 * trusted sender/listener first, installs its lexical listener, and then calls
 * `__scrubAmbient()` and `__scrubController()` before untrusted work starts.
 */
export function disposableWorkerIsolationPreludeSource(): string {
  return `
const __controllerGlobal = globalThis;
const __post = globalThis.postMessage.bind(globalThis);
const __listen = globalThis.addEventListener.bind(globalThis);
const __unlisten = globalThis.removeEventListener.bind(globalThis);
const __defineProperty = Object.defineProperty;
const __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const __getPrototypeOf = Object.getPrototypeOf;
const __hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
const __reflectApply = Reflect.apply.bind(Reflect);
const __IsolationError = Error;
const __IsolationTypeError = TypeError;

const __scrubGlobalName = (name) => {
  // Shadow the worker global and overwrite every recoverable prototype owner.
  // A future browser API that cannot be redefined fails the worker closed.
  try {
    __defineProperty(__controllerGlobal, name, {
      value: undefined, configurable: false, writable: false
    });
  } catch {}
  let target = __getPrototypeOf(__controllerGlobal);
  while (target) {
    try {
      if (__hasOwn(target, name)) {
        __defineProperty(target, name, {
          value: undefined, configurable: false, writable: false
        });
      }
    } catch {}
    target = __getPrototypeOf(target);
  }
  target = __controllerGlobal;
  while (target) {
    const descriptor = __getOwnPropertyDescriptor(target, name);
    if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
      throw new __IsolationError("Worker isolation could not hide " + name + ".");
    }
    target = __getPrototypeOf(target);
  }
};

const __ambientNames = ${JSON.stringify(DISPOSABLE_WORKER_AMBIENT_GLOBALS)};
const __scrubAmbient = () => {
  for (const name of __ambientNames) __scrubGlobalName(name);
};

const __guardControllerReceiver = (owner, name) => {
  const descriptor = __getOwnPropertyDescriptor(owner, name);
  if (!descriptor) return;
  if (typeof descriptor.value !== "function") {
    throw new __IsolationError("Worker isolation could not guard controller method " + name + ".");
  }
  const nativeMethod = descriptor.value;
  __defineProperty(owner, name, {
    ...descriptor,
    configurable: false,
    writable: false,
    value: function(...args) {
      if (this === __controllerGlobal) {
        throw new __IsolationTypeError("The worker controller EventTarget is not exposed to model code.");
      }
      return __reflectApply(nativeMethod, this, args);
    }
  });
};

const __scrubController = () => {
  // Keep generic EventTarget behavior for AbortSignal and other local objects,
  // but reject every recovered method when its receiver is this worker global.
  const eventTargetPrototype = typeof EventTarget === "function" ? EventTarget.prototype : undefined;
  if (eventTargetPrototype) {
    for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)}) {
      __guardControllerReceiver(eventTargetPrototype, name);
    }
  }
  let target = __getPrototypeOf(__controllerGlobal);
  while (target && target !== eventTargetPrototype) {
    for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)}) {
      __guardControllerReceiver(target, name);
    }
    target = __getPrototypeOf(target);
  }
  for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_GLOBALS)}) {
    __scrubGlobalName(name);
  }
  for (const name of ${JSON.stringify(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)}) {
    __defineProperty(__controllerGlobal, name, {
      value: undefined, configurable: false, writable: false
    });
  }
};
`;
}
